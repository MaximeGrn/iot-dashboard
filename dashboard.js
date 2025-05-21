/*
 * dashboard.js  —  v4
 * -------------------------------------------------------------
 * • Syntaxe reconnue : `nano<N>/telemetry` (sans slash).
 * • Affiche l'**heure** de connexion/déconnexion (HH:mm:ss) au lieu de la durée.
 * • Sonde l'état toutes les 1 s ; TIMEOUT = 3 s sans trame ➜ hors‑ligne.
 * • Corrige le bug où le statut restait fantôme (online/offline) malgré le flux.
 *   → on maintient une machine d'état explicite {online, offline}.
 */

(() => {
  /* === CONFIG ========================================================== */
  const brokerUrl   = 'ws://10.42.0.1:9001/mqtt';
  const credentials = { username: 'maxime', password: 'Eseo2025' };
  const CHECK_EVERY = 1_000;           // vérif chaque seconde
  const TIMEOUT     = 3_000;           // au‑delà de 3 s sans trame ➜ offline

  /* === DOM ============================================================ */
  const dashboard = document.getElementById('dashboard');
  const placeholder = createMsg('🔄 En attente de données MQTT…');
  dashboard.appendChild(placeholder);
  const nano1Info = createMsg('⚠️ Nano1 non connecté', '#d33');
  dashboard.appendChild(nano1Info);

  // Bouton de suppression du cache
  const clearCacheButton = document.createElement('button');
  clearCacheButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-cookie"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17a1 1 0 0 0 1 1 1 1 0 0 0 1-1v-.01"/><path d="M7 14a1 1 0 0 0 1 1 1 1 0 0 0 1-1v-.01"/></svg> <span>Vider le cache</span>';
  clearCacheButton.setAttribute('id', 'clearCacheBtn');
  clearCacheButton.onclick = () => {
    if (confirm("Êtes-vous sûr de vouloir vider le cache du site ? Cela supprimera toutes les données stockées localement par ce site.")) {
      localStorage.clear();
      sessionStorage.clear();
      // Supprimer les cookies spécifiques au site (plus complexe, nécessite de connaître les noms des cookies)
      // Pour une suppression plus générale, on informe l'utilisateur.
      alert("Cache local et de session vidé. Pour une suppression complète des cookies, veuillez le faire via les paramètres de votre navigateur.");
      location.reload(true); // Recharge la page en ignorant le cache du navigateur
    }
  };
  document.body.insertBefore(clearCacheButton, document.body.firstChild);

  function createMsg(txt, color='#000') {
    const p = document.createElement('p');
    p.textContent = txt;
    p.style.cssText = `font:15px system-ui,sans-serif;color:${color};margin:0 1rem 1rem;opacity:.8`;
    return p;
  }

  /* === STATE =========================================================== */
  const nodes = {};
  // node = { key, card, metricsWrap, statusEl, chart, datasets, lastSeen, connectedAt, disconnectedAt, online }

  /* === MQTT ============================================================ */
  const client = mqtt.connect(brokerUrl, credentials);

  client.on('connect', () => {
    console.log('[dashboard] MQTT connected');
    client.subscribe('#');
  });

  client.on('message', (topic, payload, packet) => {
    const m = /^nano(\d+)\/telemetry$/.exec(topic);
    if (!m) return;

    const nanoId = m[1];
    const key = `nano${nanoId}`;
    let data;
    try { data = JSON.parse(payload.toString()); }
    catch { return console.warn('payload JSON invalide :', payload.toString()); }

    if (placeholder.parentNode) placeholder.remove();

    const node = nodes[key] ?? createNodeCard(key);
    const now = Date.now();

    node.lastSeen = now;

    if (!packet.retain) {
      if (!node.online) {
        node.online = true;
        node.connectedAt = now;
        node.disconnectedAt = null;
      }
    }

    updateStatus(node);
    updateMetrics(node, data, now);

    if (key === 'nano1' && nano1Info.parentNode) nano1Info.remove();
  });

  /* === HEARTBEAT ======================================================= */
  setInterval(() => {
    const now = Date.now();
    for (const node of Object.values(nodes)) {
      if (node.online && now - node.lastSeen > TIMEOUT) {
        node.online = false;
        node.disconnectedAt = now;
        node.connectedAt = null;
        updateStatus(node);
      }
    }
    // nano1 warning
    if (!nodes.nano1 || (nodes.nano1 && !nodes.nano1.online)) {
      if (!nano1Info.parentNode) dashboard.insertBefore(nano1Info, dashboard.firstChild);
      const t = nodes.nano1?.disconnectedAt ? fmtTime(nodes.nano1.disconnectedAt) : '…';
      nano1Info.textContent = `⚠️ Moniteur Batterie déconnecté depuis ${t}`;
    }
  }, CHECK_EVERY);

  /* === UI BUILDERS ===================================================== */
  function createNodeCard(key) {
    const card = document.createElement('section');
    card.className = 'nano-card';

    let displayName = key; // Default to key
    let cardOrder = Infinity; // Default order for non-specified cards

    if (key === 'nano1') {
      displayName = 'Moniteur Batterie';
      cardOrder = 1;
    } else if (key.startsWith('nano')) {
      const numberPart = key.substring(4); // Remove "nano"
      const number = parseInt(numberPart, 10);
      if (!isNaN(number) && number > 1) {
        displayName = `Capteur ${number - 1}`;
        cardOrder = number; // nano2 will be 2, nano3 will be 3, etc.
      }
    }
    card.dataset.order = cardOrder; // Stocker l'ordre pour le tri

    card.innerHTML = `<h3>${displayName} <span class="status"></span></h3><div class="metrics-grid"></div><canvas></canvas>`;

    // Insertion ordonnée des cartes
    const existingCards = Array.from(dashboard.querySelectorAll('.nano-card'));
    let inserted = false;
    for (const existingCard of existingCards) {
      const existingOrder = parseInt(existingCard.dataset.order, 10);
      if (cardOrder < existingOrder) {
        dashboard.insertBefore(card, existingCard);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      dashboard.appendChild(card);
    }

    const chart = new Chart(card.querySelector('canvas').getContext('2d'), {
      type: 'line',
      data: { datasets: [] },
      options: { animation:false,responsive:true,maintainAspectRatio:true,
        scales:{x:{type:'time',time:{unit:'minute'}},y:{beginAtZero:true}},plugins:{legend:{display:true}} }
    });

    const node = {
      key,
      card,
      metricsWrap: card.querySelector('.metrics-grid'),
      statusEl: card.querySelector('.status'),
      chart,
      datasets: {},
      lastSeen: 0,
      connectedAt: null,
      disconnectedAt: null,
      online: false
    };
    nodes[key] = node;
    updateStatus(node);
    return node;
  }

  function updateStatus(node) {
    const el = node.statusEl;
    if (node.online) {
      el.textContent = `🟢 Connecté depuis ${fmtTime(node.connectedAt)}`;
      el.style.color = '#2a9d3c';
      node.card.classList.add('online');
      node.card.classList.remove('offline');
    } else {
      el.textContent = `🔴 Déconnecté depuis ${fmtTime(node.disconnectedAt)}`;
      el.style.color = '#d33';
      node.card.classList.add('offline');
      node.card.classList.remove('online');
    }
  }

  /* === METRICS ========================================================= */
  function updateMetrics(node, data, ts) {
    // Fusion prox
    const prox = ['prox1','prox2','prox3'].map(k=>data[k]).filter(v=>v!==undefined);
    if (prox.length) updateMetric(node,'proximity',prox.join(' / '),ts,{textOnly:true});

    for (const [k,v] of Object.entries(data)) {
      if (k.startsWith('prox')) continue;
      updateMetric(node,k,v,ts);
    }
  }

  function updateMetric(node,k,raw,ts,{textOnly=false}={}) {
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
    el.querySelector('.metric-value').textContent = textOnly ? raw : fmtValue(k, Number(raw));

    if (!textOnly) {
      const ds = node.datasets[k];
      ds.data.push({ x: ts, y: Number(raw) });
      if (ds.data.length > 3600) ds.data.shift();
      node.chart.update('none');
    }
  }

  /* === UTILS =========================================================== */
  const LABELS = { voltage:'Tension (V)', current:'Courant (A)', lux:'Luminosité (lx)', temp_air:'Temp. Air (°C)', hum_air:'Hum. Air (%)', hum_sol:'Hum. Sol (%)', proximity:'Proximité 1/2/3' };
  const DEC = { voltage:2, current:2, temp_air:1 };
  const fmtValue = (k,v)=>v.toFixed(DEC[k]??0);
  const randColor = ()=>`hsl(${Math.floor(Math.random()*360)},70%,50%)`;
  const fmtTime = t => {
    if (!t) return '…';
    const d = new Date(t);
    return d.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  };
})();
