/*
 * dashboard.js  —  v4
 * -------------------------------------------------------------
 * • Syntaxe reconnue : `nano<N>/telemetry` (sans slash).
 * • Affiche l'**heure** de connexion/déconnexion (HH:mm:ss) au lieu de la durée.
 * • Sonde l'état toutes les 1 s ; TIMEOUT = 3 s sans trame ➜ hors‑ligne.
 * • Corrige le bug où le statut restait fantôme (online/offline) malgré le flux.
 *   → on maintient une machine d'état explicite {online, offline}.
 * • Persistance des données de session (graphiques, état) lors des rafraîchissements.
 */

(() => {
  /* === CONFIG ========================================================== */
  const brokerUrl   = 'ws://10.42.0.1:9001/mqtt';
  const credentials = { username: 'maxime', password: 'Eseo2025' };
  const CHECK_EVERY = 1_000;           // vérif chaque seconde
  const TIMEOUT     = 3_000;           // au‑delà de 3 s sans trame ➜ offline

  /* === DOM ============================================================ */
  const dashboard = document.getElementById('dashboard');
  const placeholder = createMsg('🔄 En attente de données MQTT ou de session…');
  dashboard.appendChild(placeholder);
  const nano1Info = createMsg('⚠️ Moniteur Batterie non connecté', '#d33');
  // nano1Info n'est pas ajouté au DOM ici, le heartbeat s'en chargera si besoin

  if (typeof Chart !== 'undefined') {
    Chart.defaults.locale = 'fr-FR';
  }

  const clearCacheButton = document.createElement('button');
  clearCacheButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-cookie"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17a1 1 0 0 0 1 1 1 1 0 0 0 1-1v-.01"/><path d="M7 14a1 1 0 0 0 1 1 1 1 0 0 0 1-1v-.01"/></svg> <span>Vider le cache</span>';
  clearCacheButton.setAttribute('id', 'clearCacheBtn');
  clearCacheButton.onclick = () => {
    if (confirm("Êtes-vous sûr de vouloir vider le cache du site ? Cela supprimera toutes les données stockées localement et en session par ce site.")) {
      localStorage.clear();
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i);
          if (key && key.startsWith('dashboard_node_')) {
              sessionStorage.removeItem(key);
          }
      }
      alert("Cache local et de session vidé. Pour une suppression complète des cookies, veuillez le faire via les paramètres de votre navigateur.");
      location.reload(true);
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

  /* === SESSION STORAGE =============================================== */
  function saveNodeDataToSession(node) {
    if (!node || !node.key) return;
    const serializableData = {
      key: node.key,
      online: node.online,
      connectedAt: node.connectedAt,
      disconnectedAt: node.disconnectedAt,
      lastSeen: node.lastSeen,
      chartData: {},
      metrics: {} // Nouvel objet pour stocker les valeurs textuelles comme prox_error
    };
    
    // Sauvegarder les données de métriques textuelles
    const textMetrics = node.metricsWrap.querySelectorAll('[data-k]');
    textMetrics.forEach(el => {
      const key = el.dataset.k;
      const valueEl = el.querySelector('.metric-value');
      if (valueEl && valueEl.textContent) {
        serializableData.metrics[key] = valueEl.textContent;
      }
    });
    
    for (const chartKey in node.charts) {
      if (node.charts[chartKey] && node.charts[chartKey].data && node.charts[chartKey].data.datasets[0]) {
        serializableData.chartData[chartKey] = node.charts[chartKey].data.datasets[0].data;
      }
    }
    try {
      sessionStorage.setItem('dashboard_node_' + node.key, JSON.stringify(serializableData));
    } catch (e) {
      console.warn('Impossible de sauvegarder le nœud dans sessionStorage:', e);
    }
  }

  function loadAndRecreateNodesFromSession() {
    let nodesFoundInSession = false;
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith('dashboard_node_')) {
        try {
          const storedNodeDataString = sessionStorage.getItem(key);
          if (!storedNodeDataString) continue;
          const storedNodeData = JSON.parse(storedNodeDataString);

          if (placeholder.parentNode) placeholder.remove();
          nodesFoundInSession = true;

          const node = nodes[storedNodeData.key] ?? createNodeCard(storedNodeData.key);
          
          node.online = storedNodeData.online;
          node.connectedAt = storedNodeData.connectedAt;
          node.disconnectedAt = storedNodeData.disconnectedAt;
          node.lastSeen = storedNodeData.lastSeen;
          
          updateStatus(node); // Met à jour l'UI et sauvegarde cette partie de l'état

          // Restaurer les métriques textuelles si disponibles
          if (storedNodeData.metrics) {
            for (const metricKey in storedNodeData.metrics) {
              if (Object.prototype.hasOwnProperty.call(storedNodeData.metrics, metricKey)) {
                const metricValue = storedNodeData.metrics[metricKey];
                if (metricValue) {
                  // Déterminer s'il s'agit d'une métrique custom ou standard
                  const isCustom = !LABELS[metricKey];
                  updateMetric(node, metricKey, metricValue, undefined, {
                    textOnly: true,
                    customLabel: isCustom && metricKey === 'prox_error' ? 'État capteurs' : null,
                    fromSession: true
                  });
                }
              }
            }
          }

          if (storedNodeData.chartData) {
            for (const metricKey in storedNodeData.chartData) {
              if (Object.prototype.hasOwnProperty.call(storedNodeData.chartData, metricKey)) {
                const dataPointsArray = storedNodeData.chartData[metricKey];
                if (dataPointsArray && Array.isArray(dataPointsArray) && dataPointsArray.length > 0) {
                  // Appel direct avec l'objet options en ligne
                  updateMetric(node, metricKey, dataPointsArray, undefined, 
                    { 
                      textOnly: false, 
                      customLabel: LABELS[metricKey] || metricKey, 
                      fromSession: true 
                    }
                  );
                }
              }
            }
          }
        } catch (e) {
          console.warn('Impossible de charger le nœud depuis sessionStorage:', key, e);
        }
      }
    }
    // Si aucun nœud n'a été chargé depuis la session et que le placeholder est toujours là
    if (!nodesFoundInSession && placeholder.textContent === '🔄 En attente de données MQTT ou de session…') {
        placeholder.textContent = '🔄 En attente de données MQTT…';
    }
  }

  /* === MQTT ============================================================ */
  const client = mqtt.connect(brokerUrl, credentials);

  client.on('connect', () => {
    console.log('[dashboard] MQTT connected');
    if (placeholder.parentNode && placeholder.textContent === '🔄 En attente de données MQTT ou de session…'){
        placeholder.textContent = '🔄 En attente de données MQTT…'; // Si la session n'a rien chargé
    }
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

    // La logique de nano1Info est gérée par le heartbeat
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
    // Gestion de l'affichage du message pour nano1
    if (!nodes.nano1 || !nodes.nano1.online) {
      if (!nano1Info.parentNode) dashboard.insertBefore(nano1Info, dashboard.firstChild);
      const t = nodes.nano1?.disconnectedAt ? fmtTime(nodes.nano1.disconnectedAt) : (nodes.nano1?.lastSeen ? 'jamais connecté' : '…');
      nano1Info.textContent = `⚠️ Moniteur Batterie déconnecté depuis ${t}`;
    } else if (nodes.nano1 && nodes.nano1.online && nano1Info.parentNode) {
      nano1Info.remove();
    }
  }, CHECK_EVERY);

  /* === UI BUILDERS ===================================================== */
  function createNodeCard(key) {
    const card = document.createElement('section');
    card.className = 'nano-card';

    let displayName = key; 
    let cardOrder = Infinity; 

    if (key === 'nano1') {
      displayName = 'Moniteur Batterie';
      cardOrder = 1;
    } else if (key.startsWith('nano')) {
      const numberPart = key.substring(4); 
      const number = parseInt(numberPart, 10);
      if (!isNaN(number) && number > 1) {
        displayName = `Capteur ${number - 1}`;
        cardOrder = number; 
      }
    }
    card.dataset.order = cardOrder; 

    card.innerHTML = `<h3>${displayName} <span class="status"></span></h3><div class="metrics-grid"></div><div class="charts-container"></div>`;

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

    const node = {
      key,
      card,
      metricsWrap: card.querySelector('.metrics-grid'),
      statusEl: card.querySelector('.status'),
      chartsContainer: card.querySelector('.charts-container'),
      charts: {},
      lastSeen: 0,
      connectedAt: null,
      disconnectedAt: null,
      online: false
    };
    nodes[key] = node;
    card.dataset.nanoId = key.substring(4);
    // Ne pas appeler updateStatus ici si on restaure depuis la session, 
    // car loadAndRecreateNodesFromSession le fera après avoir mis les bonnes valeurs.
    // Si ce n'est pas une restauration, MQTT le fera.
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
    saveNodeDataToSession(node);
  }

  /* === METRICS ========================================================= */
  function updateMetrics(node, data, ts) {
    if (node.key !== 'nano1') {
        // Pour les cartes nano2, nano3, nano4, etc. - ordre défini
        const orderedMetrics = ['lux', 'temp_air', 'hum_air', 'hum_sol', 'proximity'];
        
        // Traitement spécial pour la taille de la pousse
        const prox1 = data.prox1 === true;
        const prox2 = data.prox2 === true;
        const prox3 = data.prox3 === true;
        
        let heightText = '';
        let errorMsg = '';
        
        // Détermination de la taille selon la logique demandée
        if (!prox1 && !prox2 && !prox3) {
            heightText = '0 cm';
        } else if (prox1 && !prox2 && !prox3) {
            heightText = '5 cm';
        } else if (prox1 && prox2 && !prox3) {
            heightText = '10 cm';
        } else if (prox1 && prox2 && prox3) {
            heightText = '>15 cm';
        } else {
            // Cas incohérent
            heightText = 'Incohérent';
            
            // Construction du message d'erreur
            if (!prox1) {
                if (prox2 || prox3) {
                    errorMsg = 'Dysfonctionnement capteur hauteur n°1';
                    if (prox2 && prox3) {
                        errorMsg += '.';
                    } else if (!prox2 && prox3) {
                        errorMsg += ' et n°2.';
                    } else {
                        errorMsg += '.';
                    }
                }
            } else if (prox1 && !prox2 && prox3) {
                errorMsg = 'Dysfonctionnement capteur hauteur n°2.';
            }
        }
        
        // Mettre à jour avec la nouvelle valeur et éventuellement le message d'erreur
        updateMetric(node, 'proximity', heightText, ts, {textOnly:true});
        
        // Si message d'erreur, l'afficher sous la taille
        if (errorMsg) {
            updateMetric(node, 'prox_error', errorMsg, ts, {textOnly:true, customLabel:'État capteurs'});
        } else {
            // Supprimer l'erreur si elle existait et qu'il n'y a plus d'incohérence
            const errorEl = node.metricsWrap.querySelector('[data-k="prox_error"]');
            if (errorEl) errorEl.remove();
        }
        
        // Mettre à jour les autres métriques dans l'ordre défini
        for (const k of orderedMetrics) {
            if (k === 'proximity') continue; // Déjà traité ci-dessus
            if (data[k] !== undefined) {
                updateMetric(node, k, data[k], ts);
            }
        }
    } else {
        // Pour nano1 (Moniteur Batterie) - comportement d'origine
    const prox = ['prox1','prox2','prox3'].map(k=>data[k]).filter(v=>v!==undefined);
    if (prox.length) updateMetric(node,'proximity',prox.join(' / '),ts,{textOnly:true});

    for (const [k,v] of Object.entries(data)) {
      if (k.startsWith('prox') || k === 'datetime_str') continue;
      updateMetric(node,k,v,ts);
    }

        if (data.current !== undefined) {
      const statusText = Number(data.current) > 1 ? 'Charge en cours' : 'Utilisation en cours';
      updateMetric(node, 'battery_status', statusText, ts, { textOnly: true, customLabel: 'État Batterie' });
        }
    }
  }

  function updateMetric(node,k,raw,ts,{textOnly=false, customLabel=null, fromSession=false}={}) {
    const label = customLabel || LABELS[k] || k;
    let metricDisplayEl = node.metricsWrap.querySelector(`[data-k="${k}"]`);
    
    // Création de l'élément s'il n'existe pas
    if (!metricDisplayEl) {
      metricDisplayEl = document.createElement('div');
      metricDisplayEl.dataset.k = k;
      metricDisplayEl.innerHTML = `<span class="metric-label">${label}: </span><span class="metric-value"></span>`;
        
        // Définir l'ordre d'affichage des métriques
        if (node.key !== 'nano1') {
            // Ordre pour les cartes nano2+
            const orderMap = {
                'lux': 1,
                'temp_air': 2,
                'hum_air': 3,
                'hum_sol': 4,
                'proximity': 5,
                'prox_error': 6
            };
            
            metricDisplayEl.dataset.order = orderMap[k] || 99;
            
            // Insérer au bon endroit selon l'ordre
            let inserted = false;
            Array.from(node.metricsWrap.children).forEach(child => {
                const childOrder = parseInt(child.dataset.order || 99);
                const newOrder = parseInt(metricDisplayEl.dataset.order);
                
                if (newOrder < childOrder && !inserted) {
                    node.metricsWrap.insertBefore(metricDisplayEl, child);
                    inserted = true;
                }
            });
            
            // Si pas inséré, ajouter à la fin
            if (!inserted) {
                node.metricsWrap.appendChild(metricDisplayEl);
            }
        } else {
            // Pour nano1, comportement d'origine
      node.metricsWrap.appendChild(metricDisplayEl);
        }
    }
    
    // N'afficher la valeur que si elle est fournie
    if (raw !== undefined && !Array.isArray(raw)) { 
        metricDisplayEl.querySelector('.metric-value').textContent = textOnly ? raw : fmtValue(k, Number(raw));
    } else if (textOnly && raw !== undefined) {
        metricDisplayEl.querySelector('.metric-value').textContent = raw;
    }

    if (!textOnly && k !== 'datetime_str') {
      let chartInstance = node.charts[k];
      if (!chartInstance) {
        const canvas = document.createElement('canvas');
        canvas.style.height = '150px';
        canvas.style.width = '100%';
        node.chartsContainer.appendChild(canvas);
        
        const newChart = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            datasets: [{
              label: label,
              data: [],
              borderColor: METRIC_COLORS[k] || randColor(),
              borderWidth:1,
              tension:.25,
              pointRadius:0
            }]
          },
          options: {
            animation:false,
            responsive:true,
            maintainAspectRatio: true,
            scales:{
              x:{
                type:'time',
                time:{
                  unit:'minute',
                  displayFormats: {
                    minute: 'HH:mm',
                    hour: 'HH:mm'
                  }
                }
              },
              y:{beginAtZero:true}
            },
            plugins:{
              legend:{display:true, position: 'top'}
            }
          }
        });
        node.charts[k] = newChart;
        chartInstance = newChart;
      }

      if (fromSession && Array.isArray(raw)) { // Cas spécifique de chargement depuis la session
        chartInstance.data.datasets[0].data = raw;
        chartInstance.update('none');
      } else if (ts !== undefined && raw !== undefined && !Array.isArray(raw)) { // Cas de mise à jour normale
        const dataset = chartInstance.data.datasets[0];
        dataset.data.push({ x: ts, y: Number(raw) });
        if (dataset.data.length > 300) dataset.data.shift();
        chartInstance.update('none');
      } // Ne rien faire d'autre si raw ou ts sont undefined et que ce n'est pas fromSession
      
      saveNodeDataToSession(node); 
    } else if (textOnly) {
      saveNodeDataToSession(node);
    }
  }

  /* === UTILS =========================================================== */
  const LABELS = { voltage:'Tension (V)', current:'Courant (A)', lux:'Luminosité (lx)', temp_air:'Temp. Air (°C)', hum_air:'Hum. Air (%)', hum_sol:'Hum. Sol (%)', proximity:'Taille de la pousse' };
  const DEC = { voltage:2, current:2, temp_air:1 };
  const METRIC_COLORS = {
    voltage: '#FFD700', 
    current: '#4682B4', 
    lux: '#FFA500',     
    temp_air: '#007BFF', 
    hum_air: '#32CD32',  
    hum_sol: '#8B4513'   
  };
  const fmtValue = (k,v)=>v.toFixed(DEC[k]??0);
  const randColor = ()=>`hsl(${Math.floor(Math.random()*360)},70%,50%)`;
  const fmtTime = t => {
    if (!t) return '…';
    const d = new Date(t);
    return d.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  };
  // Charger les nœuds depuis la session
  loadAndRecreateNodesFromSession();

  // — Historique au clic sur carte —
  dashboard.addEventListener('click', async e => {
    const card = e.target.closest('.nano-card');
    if (!card) return;

    const nanoId = card.dataset.nanoId;
    if (!nanoId) return;

    // Rediriger vers une nouvelle page pour tous les nano (y compris nano1)
    window.location.href = `details_capteur.html?nanoId=${nanoId}`;
    
    // L'ancien code pour afficher l'historique directement sur le dashboard n'est plus nécessaire ici
    // car la page details_capteur.html s'en chargera.
    /*
    if (nanoId !== '1') { 
      window.location.href = `details_capteur.html?nanoId=${nanoId}`;
    } else {
      // Comportement existant pour nano1 (Moniteur Batterie)
      console.log('DEBUG click sur carte nano1', card, 'nanoId=', nanoId);
      try {
        const resp = await fetch(`http://${window.location.hostname}:5000/api/last?nano=${nanoId}&n=1000`);
        if (!resp.ok) {
          console.error(`Erreur lors de la récupération de l'historique pour nano${nanoId}: ${resp.status}`);
          return;
        }
        const history = await resp.json();
        showHistory(card, history);
      } catch (error) {
        console.error('Erreur de fetch pour l\'historique:', error);
      }
    }
    */
  });

  // La fonction showHistory peut être conservée si elle est utilisée ailleurs, 
  // ou supprimée si elle n'était utilisée que pour l'affichage direct sur le dashboard.
  // Pour l'instant, je la laisse commentée au cas où.
  /*
  function showHistory(card, rows) {
    let hist = card.querySelector('.history');
    if (hist) hist.remove();
    hist = document.createElement('div');
    hist.className = 'history';
    hist.innerHTML = `<h4>Historique (dernier ${rows.length} points)</h4><canvas></canvas>`;
    card.appendChild(hist);
    const ctx = hist.querySelector('canvas').getContext('2d');
    new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [{
          label: 'Lux',
          data: rows.map(r => ({ x: r.ts_device_ms, y: r.lux })),
          tension: 0.2,
          pointRadius: 0
        }]
      },
      options: {
        scales: {
          x: { type: 'time', time: { unit: 'minute', displayFormats: { minute:'HH:mm' } } },
          y: { beginAtZero: true }
        }
      }
    });
  }
  */

})(); 
