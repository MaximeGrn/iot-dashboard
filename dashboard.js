/*
 * dashboard.js  —  v3
 * -------------------------------------------------------------
 * • Ne gère que la syntaxe `nano<N>/telemetry` (sans slash).
 * • Message global si **nano1** jamais vu ou perdu.
 * • Pour chaque Nano : badge « Connecté depuis … » ou
 *   « Déconnecté depuis … » mis à jour toutes les 30 s.
 */

(() => {
  /* === CONFIG ========================================================== */
  const brokerUrl   = 'ws://10.42.0.1:9001/mqtt';
  const credentials = { username: 'maxime', password: 'Eseo2025' };
  const CHECK_EVERY = 10_000;          // pas de rafraîchissement (ms)
  const TIMEOUT     = CHECK_EVERY + 1; // délai avant « déconnecté » (ms)

  /* === DOM ELEMENTS ==================================================== */
  const dashboard   = document.getElementById('dashboard');

  // Placeholder général tant qu'aucun Nano n'a parlé
  const placeholder = Object.assign(document.createElement('p'), {
    textContent: '🔄 En attente de données MQTT…',
    style: 'font:16px system-ui,sans-serif;opacity:.7;margin:1rem'
  });
  dashboard.appendChild(placeholder);

  // Message spécial pour la Nano 1
  const nano1Info = Object.assign(document.createElement('p'), {
    textContent: '⚠️  Nano1 non connectée',
    style: 'font:15px system-ui,sans-serif;color:#d33;margin:0 1rem 1rem'
  });
  dashboard.appendChild(nano1Info);

  /* === STATE =========================================================== */
  const nodes = {}; // key → { card, statusEl, lastSeen, connectedSince }

  /* === MQTT ============================================================ */
  const client = mqtt.connect(brokerUrl, credentials);

  client.on('connect', () => {
    console.log('[dashboard] MQTT connected');
    // Charger les nœuds depuis localStorage avant de s'abonner
    loadNodesFromCache();
    client.subscribe('#'); // on écoute tout
  });

  client.on('message', (topic, payloadBuf) => {
    const m = /^nano(\d+)\/telemetry$/.exec(topic);
    if (!m) return; // ignore les autres topics

    const nanoId  = m[1];
    const nodeKey = `nano${nanoId}`;

    let data;
    try { data = JSON.parse(payloadBuf.toString()); }
    catch { return console.warn('payload JSON invalide', payloadBuf.toString()); }

    if (placeholder.parentNode) placeholder.remove();

    const node = nodes[nodeKey] ?? createNodeCard(nodeKey);

    // Marquage de présence
    if (!node.connectedSince) node.connectedSince = Date.now();
    node.lastSeen = Date.now();
    updateStatus(node, true);

    updateMetrics(node, data);
    saveNodeToCache(nodeKey); // Sauvegarder après mise à jour

    // Gestion du message nano1
    if (nodeKey === 'nano1') nano1Info.remove();
  });

  /* === STATUS REFRESH TIMER =========================================== */
  setInterval(() => {
    const now = Date.now();
    for (const node of Object.values(nodes)) {
      const offline = now - (node.lastSeen || 0) > TIMEOUT;
      updateStatus(node, !offline);
      if (offline && node.connectedSince) { // Si déconnecté, reset connectedSince
        node.connectedSince = null;
      }
    }
    saveAllNodesToCache(); // Sauvegarder l'état de tous les nœuds périodiquement

    // Nano1 toujours absente ?
    if (!nodes.nano1) {
      // nothing – message déjà visible
    } else if (Date.now() - nodes.nano1.lastSeen > TIMEOUT) {
      if (!nano1Info.parentNode) dashboard.insertBefore(nano1Info, dashboard.firstChild);
      nano1Info.textContent = '⚠️  Nano1 déconnectée depuis ' + fmtDuration(Date.now() - nodes.nano1.lastSeen);
    }
  }, CHECK_EVERY);

  /* === UI FUNCTIONS ==================================================== */
  function createNodeCard(key) {
    const card = document.createElement('section');
    card.className = 'nano-card';
    // Le contenu HTML sera rempli avec les données, qu'elles soient nouvelles ou du cache
    dashboard.appendChild(card);

    let cachedNodeData = getNodeFromCache(key);

    card.innerHTML = `<h3>${key} <span class="status"></span></h3><div class="metrics-grid"></div><canvas></canvas>`;

    const chart = new Chart(card.querySelector('canvas').getContext('2d'), {
      type: 'line',
      data: { datasets: cachedNodeData?.datasetsData || [] }, // Utiliser les données du cache pour les datasets
      options: { animation:false,responsive:true,maintainAspectRatio:false,
        scales:{x:{type:'time',time:{unit:'minute'}},y:{beginAtZero:true}},plugins:{legend:{display:true}} }
    });

    const node = {
      key,
      card,
      metricsWrap : card.querySelector('.metrics-grid'),
      statusEl    : card.querySelector('.status'),
      chart,
      datasets    : {}, // Sera peuplé à partir de chart.data.datasets ou lors de updateMetric
      lastSeen    : cachedNodeData?.lastSeen || null,
      connectedSince : cachedNodeData?.connectedSince || null
    };

    // Restaurer les datasets dans node.datasets pour la logique existante
    chart.data.datasets.forEach(ds => {
        // Trouver la clé de la métrique originale. Peut nécessiter un ajustement si le label n'est pas unique ou formaté.
        // Pour l'instant, on suppose que le label du dataset est la clé de la métrique.
        // Cela pourrait être plus robuste en stockant la clé k avec le dataset dans le cache.
        const metricKey = Object.keys(LABELS).find(k => LABELS[k] === ds.label) || ds.label;
        node.datasets[metricKey] = ds;
    });

    // Restaurer les valeurs des métriques affichées si des données cachées existent
    if (cachedNodeData?.metrics) {
        for (const [k, metricData] of Object.entries(cachedNodeData.metrics)) {
            const { value, textOnly, ts } = metricData;
            // Recréer l'élément de métrique DOM si nécessaire (similaire à updateMetric)
            let el = node.metricsWrap.querySelector(`[data-k="${k}"]`);
            if (!el) {
                el = document.createElement('div');
                el.dataset.k = k;
                const label = LABELS[k] || k;
                el.innerHTML = `<span class="metric-label">${label}: </span><span class="metric-value"></span>`;
                node.metricsWrap.appendChild(el);
            }
            el.querySelector('.metric-value').textContent = textOnly ? value : fmtValue(k, Number(value));
        }
    }
     if (cachedNodeData) {
      updateStatus(node, (Date.now() - (cachedNodeData.lastSeen || 0) <= TIMEOUT));
    } else {
      // Comportement par défaut pour un nouveau noeud sans cache (peut-être le marquer comme déconnecté initialement)
      updateStatus(node, false);
    }

    nodes[key] = node;
    return node;
  }

  function updateMetrics(node, data) {
    const ts = Date.now();

    // Prox fusionné
    if ('prox1' in data || 'prox2' in data || 'prox3' in data) {
      const str = ['prox1','prox2','prox3'].map(k=>data[k]).filter(v=>v!==undefined).join(' / ');
      if (str) updateMetric(node,'proximity',str,ts,{textOnly:true});
    }

    for (const [k,v] of Object.entries(data)) {
      if (k.startsWith('prox')) continue;
      updateMetric(node,k,v,ts);
    }
    saveNodeToCache(node.key); // Sauvegarder après la mise à jour des métriques
  }

  function updateMetric(node,k,raw,ts,{textOnly=false}={}) {
    const val = Number(raw);
    const label = LABELS[k] || k;
    let el = node.metricsWrap.querySelector(`[data-k="${k}"]`);

    if (!el) {
      el = document.createElement('div');
      el.dataset.k = k;
      el.innerHTML = `<span class="metric-label">${label}: </span><span class="metric-value"></span>`;
      node.metricsWrap.appendChild(el);

      if (!textOnly) {
        const ds = { label, data: [], borderColor: randColor(), borderWidth:1, tension:.25, pointRadius:0 };
        node.chart.data.datasets.push(ds);
        node.datasets[k] = ds;
      }
    }

    el.querySelector('.metric-value').textContent = textOnly ? raw : fmtValue(k,val);

    if (!textOnly) {
      const ds = node.datasets[k];
      ds.data.push({ x: ts, y: val });
      if (ds.data.length > 3600) ds.data.shift();
      node.chart.update('none');
    }
  }

  function updateStatus(node, online) {
    const el = node.statusEl;
    if (online) {
      const dur = fmtDuration(Date.now() - node.connectedSince);
      el.textContent = `🟢 connecté·e depuis ${dur}`;
      el.style.color = '#2a9d3c';
      node.card.classList.remove('offline'); // CSS class for styling
      node.card.classList.add('online');
    } else {
      const dur = fmtDuration(Date.now() - (node.lastSeen || Date.now())); // Utiliser Date.now() si lastSeen est null
      el.textContent = `🔴 déconnecté·e depuis ${dur}`;
      el.style.color = '#d33';
      node.card.classList.remove('online');
      node.card.classList.add('offline');
      if (node.connectedSince) node.connectedSince = null; // Réinitialiser si marqué hors ligne
    }
  }

  /* === UTILS =========================================================== */
  const LABELS = { voltage:'Voltage (V)', current:'Current (A)', lux:'Lux (lx)', temp_air:'Temp (°C)', hum_air:'Hum (%)', hum_sol:'Hum Sol (%)', proximity:'Prox 1/2/3' };
  const DEC = { voltage:2, current:2, temp_air:1 };
  const fmtValue = (k,v)=>v.toFixed(DEC[k]??0);
  const randColor = ()=>`hsl(${Math.floor(Math.random()*360)},70%,50%)`;

  function fmtDuration(ms) {
    const sec = Math.floor(ms/1000);
    const min = Math.floor(sec/60);
    const s   = sec%60;
    return `${min?min+'min':''}${min&&s? '':''}${s? s+'s':''}` || '0s';
  }

  /* === CACHE FUNCTIONS ================================================= */
  const CACHE_PREFIX = 'nanoDashboard_';

  function saveNodeToCache(nodeKey) {
    const node = nodes[nodeKey];
    if (!node) return;

    const metricsToSave = {};
    node.metricsWrap.querySelectorAll('[data-k]').forEach(el => {
        const k = el.dataset.k;
        const valueEl = el.querySelector('.metric-value');
        // On a besoin de savoir si la métrique est textOnly pour la restauration
        // On va supposer pour l'instant que si node.datasets[k] n'existe pas, c'est textOnly
        // ou que l'on stocke la valeur brute affichée.
        // Une meilleure approche serait de stocker explicitement le type ou la valeur brute originale.
        const isTextOnly = !node.datasets[k]; // Approximation
        metricsToSave[k] = {
            value: valueEl.textContent, // Sauvegarde la valeur affichée
            textOnly: isTextOnly // Peut nécessiter un ajustement
        };
    });

    const datasetsData = node.chart.data.datasets.map(ds => ({
      label: ds.label,
      data: ds.data, // Sauvegarde les points de données {x,y}
      borderColor: ds.borderColor,
      borderWidth: ds.borderWidth,
      tension: ds.tension,
      pointRadius: ds.pointRadius,
      // important: stocker aussi la clé de la métrique associée si elle est différente du label
      metricKey: Object.keys(node.datasets).find(key => node.datasets[key] === ds) || ds.label
    }));


    const dataToSave = {
      lastSeen: node.lastSeen,
      connectedSince: node.connectedSince,
      datasetsData: datasetsData, // chart.js dataset structure
      metrics: metricsToSave // Sauvegarde les valeurs des métriques
    };
    try {
      localStorage.setItem(CACHE_PREFIX + nodeKey, JSON.stringify(dataToSave));
    } catch (e) {
      console.error('Erreur lors de la sauvegarde du cache pour', nodeKey, e);
      // Potentiellement, le quota localStorage est dépassé.
    }
  }

  function getNodeFromCache(nodeKey) {
    const cached = localStorage.getItem(CACHE_PREFIX + nodeKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        console.error('Erreur lors du parsing du cache pour', nodeKey, e);
        localStorage.removeItem(CACHE_PREFIX + nodeKey); // Supprimer le cache corrompu
        return null;
      }
    }
    return null;
  }

  function loadNodesFromCache() {
    if (placeholder.parentNode) placeholder.remove(); // Cacher le message "En attente"
    let hasCache = false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(CACHE_PREFIX)) {
        const nodeKey = key.substring(CACHE_PREFIX.length);
        // createNodeCard va lire du cache, donc on l'appelle.
        // Il faut s'assurer que createNodeCard ne recrée pas un noeud si déjà dans `nodes`
        // ce qui ne devrait pas arriver ici car `nodes` est vide initialement.
        if (!nodes[nodeKey]) {
             createNodeCard(nodeKey); // Ceci va utiliser getNodeFromCache
             hasCache = true;
        }
      }
    }
    if (hasCache && nodes.nano1 && (Date.now() - (nodes.nano1.lastSeen || 0) <= TIMEOUT)) {
        nano1Info.remove();
    } else if (!nodes.nano1 && nano1Info.parentNode == null) { // Si nano1 pas dans cache et message pas là
        dashboard.insertBefore(nano1Info, dashboard.firstChild);
        nano1Info.textContent = '⚠️  Nano1 non connectée (aucune donnée en cache)';
    }
    // Si placeholder toujours là et pas de cache, il reste. S'il y a du cache, il est enlevé.
    if (!hasCache && placeholder.parentNode == null && Object.keys(nodes).length === 0) {
        dashboard.appendChild(placeholder);
        placeholder.textContent = '🔄 Aucune donnée en cache, en attente de données MQTT…';
    } else if (hasCache && placeholder.parentNode) {
        placeholder.remove();
    }

  }

  function saveAllNodesToCache() {
    for (const nodeKey in nodes) {
      saveNodeToCache(nodeKey);
    }
  }

})();
