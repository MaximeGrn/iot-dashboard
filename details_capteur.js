(() => {
  /* === CONFIG ========================================================== */
  const brokerUrl = 'ws://10.42.0.1:9001/mqtt';
  const credentials = { username: 'maxime', password: 'Eseo2025' };
  const CHECK_EVERY = 1_000; 
  const TIMEOUT = 3_000;

  /* === DOM ELEMENTS ==================================================== */
  const sensorNameDisplay = document.getElementById('sensor-name-display');
  const liveStatusIndicator = document.getElementById('live-status-indicator');
  const liveMetricsGrid = document.querySelector('#live-data-section .live-metrics-grid');
  const chartsHistoryContainer = document.querySelector('#history-section .charts-history-container');
  const loadingMessage = document.getElementById('loading-message');
  const errorMessage = document.getElementById('error-message');
  const sensorDetailsContainer = document.getElementById('sensor-details-container');

  /* === STATE =========================================================== */
  let nanoId = null;
  let clientMQTT = null;
  let lastSeen = 0;
  let online = false;
  let connectedAt = null;
  let disconnectedAt = null;
  const historyCharts = {}; 

  const LABELS = {
    lux: 'Luminosité (lx)',
    temp_air: 'Temp. Air (°C)',
    hum_air: 'Hum. Air (%)',
    hum_sol: 'Hum. Sol (%)',
    proximity: 'Taille de la pousse',
    voltage: 'Tension (V)',
    current: 'Courant (A)',
    battery_status: 'État Batterie'
  };
  const DEC = { temp_air: 1, voltage: 2, current: 2 };
  const METRIC_COLORS = {
    lux: '#FFA500',
    temp_air: '#007BFF',
    hum_air: '#32CD32',
    hum_sol: '#8B4513',
    voltage: '#FFD700',
    current: '#4682B4'
  };

  /* === INITIALIZATION ================================================== */
  function init() {
    const urlParams = new URLSearchParams(window.location.search);
    nanoId = urlParams.get('nanoId');

    if (!nanoId) {
      showError("ID du capteur non spécifié dans l\'URL.");
      return;
    }

    sensorDetailsContainer.style.display = 'none'; 
    loadingMessage.style.display = 'block';

    let displayName = `Capteur ${nanoId}`;
    const numericId = parseInt(nanoId, 10);
    if (nanoId === "1") {
        displayName = "Moniteur Batterie";
    } else if (!isNaN(numericId) && numericId > 1) {
        displayName = `Capteur ${numericId - 1}`;
    }
    
    sensorNameDisplay.textContent = displayName;
    document.title = `${displayName} - Nano Dashboard`;

    connectMQTT();
    fetchHistoryData();
    startHeartbeat();
  }

  function showError(message) {
    loadingMessage.style.display = 'none';
    sensorDetailsContainer.style.display = 'none';
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    console.error(message);
  }

  /* === MQTT LOGIC ====================================================== */
  function connectMQTT() {
    clientMQTT = mqtt.connect(brokerUrl, credentials);
    const topic = `nano${nanoId}/telemetry`;

    clientMQTT.on('connect', () => {
      console.log(`[details_capteur] MQTT connecté pour nano${nanoId}`);
      clientMQTT.subscribe(topic, (err) => {
        if (err) {
          console.error(`[details_capteur] Erreur d\'abonnement MQTT à ${topic}:`, err);
          showError(`Impossible de s\'abonner aux données en direct pour nano${nanoId}.`);
        } else {
          console.log(`[details_capteur] Abonné à ${topic}`);
        }
      });
    });

    clientMQTT.on('message', (msgTopic, payload) => {
      if (msgTopic === topic) {
        try {
          const data = JSON.parse(payload.toString());
          lastSeen = Date.now();
          if (!online) {
            online = true;
            connectedAt = lastSeen;
            disconnectedAt = null;
            updateLiveStatus();
          }
          updateLiveMetrics(data);
        } catch (e) {
          console.warn('[details_capteur] Payload JSON invalide:', payload.toString(), e);
        }
      }
    });

    clientMQTT.on('error', (err) => {
      console.error('[details_capteur] Erreur MQTT:', err);
      showError('Erreur de connexion MQTT.');
    });
    
    clientMQTT.on('close', () => {
        console.log(`[details_capteur] MQTT déconnecté pour nano${nanoId}`);
        if (online) {
            online = false;
            disconnectedAt = Date.now();
            updateLiveStatus();
        }
    });
  }
  
  /* === HEARTBEAT ======================================================= */
  function startHeartbeat() {
    setInterval(() => {
      if (online && (Date.now() - lastSeen > TIMEOUT)) {
        online = false;
        disconnectedAt = Date.now();
        updateLiveStatus();
        console.warn(`[details_capteur] Timeout pour nano${nanoId}, passage en offline.`);
      }
    }, CHECK_EVERY);
  }

  /* === LIVE DATA UI ===================================================== */
   function updateLiveStatus() {
    if (online) {
      liveStatusIndicator.textContent = '🟢 En direct';
      liveStatusIndicator.style.color = '#2a9d3c';
    } else {
      liveStatusIndicator.textContent = disconnectedAt ? `🔴 Hors ligne (depuis ${fmtTime(disconnectedAt)})` : '🔴 Hors ligne';
      liveStatusIndicator.style.color = '#d33';
    }
  }
  
  function updateLiveMetrics(data) {
    if (sensorDetailsContainer.style.display === 'none') {
        loadingMessage.style.display = 'none';
        errorMessage.style.display = 'none';
        sensorDetailsContainer.style.display = 'block';
    }

    liveMetricsGrid.innerHTML = '';

    if (nanoId === '1') {
        const metricsOrderNano1 = ['voltage', 'current', 'lux', 'battery_status'];
        metricsOrderNano1.forEach(key => {
            let value;
            let label = LABELS[key] || key;

            if (key === 'battery_status') {
                value = Number(data.current) > 1 ? 'Charge en cours' : 'Utilisation en cours';
            } else if (data[key] !== undefined && data[key] !== null) {
                value = fmtValue(key, Number(data[key]));
            } else {
                value = 'N/A';
            }
            updateOrCreateLiveMetricElement(key, label, value);
        });

    } else {
        const metricsOrderNanos = ['lux', 'temp_air', 'hum_air', 'hum_sol', 'proximity'];
        
        const prox1 = data.prox1 === true;
        const prox2 = data.prox2 === true;
        const prox3 = data.prox3 === true;
        let heightText = '0 cm'; 
        let proxErrorMsg = '';

        if (!prox1 && !prox2 && !prox3) heightText = '0 cm';
        else if (prox1 && !prox2 && !prox3) heightText = '5 cm';
        else if (prox1 && prox2 && !prox3) heightText = '10 cm';
        else if (prox1 && prox2 && prox3) heightText = '>15 cm';
        else {
            heightText = 'Incohérent';
            if (!prox1 && (prox2 || prox3)) proxErrorMsg = 'Dysfonctionnement capteur hauteur n°1';
            else if (prox1 && !prox2 && prox3) proxErrorMsg = 'Dysfonctionnement capteur hauteur n°2';
        }
        
        metricsOrderNanos.forEach(key => {
          let value;
          let label = LABELS[key] || key;

          if (key === 'proximity') {
            value = heightText;
          } else if (data[key] !== undefined && data[key] !== null) {
            value = fmtValue(key, Number(data[key]));
          } else {
            value = 'N/A';
          }
          updateOrCreateLiveMetricElement(key, label, value);
        });

        if (proxErrorMsg) {
            updateOrCreateLiveMetricElement('prox_error', 'État capteurs', proxErrorMsg);
        } else {
            const errorEl = liveMetricsGrid.querySelector('[data-metric-key="prox_error"]');
            if (errorEl) errorEl.remove();
        }
    }
  }

  function updateOrCreateLiveMetricElement(key, label, value) {
    const metricEl = document.createElement('div');
    metricEl.dataset.metricKey = key;
    metricEl.innerHTML = `<span class="metric-label">${label}: </span><span class="metric-value">${value}</span>`;
    liveMetricsGrid.appendChild(metricEl); 
  }

  /* === HISTORY DATA ==================================================== */
  async function fetchHistoryData() {
    try {
      const response = await fetch(`http://${window.location.hostname}:5000/api/last?nano=${nanoId}&n=1000`);
      if (!response.ok) {
        throw new Error(`Erreur HTTP ${response.status} lors de la récupération de l\'historique.`);
      }
      const historyData = await response.json();
      
      if (!historyData || historyData.length === 0) {
          console.warn(`[details_capteur] Aucune donnée d\'historique reçue pour nano${nanoId}`);
          chartsHistoryContainer.innerHTML = '<p>Aucune donnée d\'historique disponible pour ce capteur.</p>';
          if (sensorDetailsContainer.style.display === 'none' && (!clientMQTT || !clientMQTT.connected)) {
            loadingMessage.style.display = 'none';
            sensorDetailsContainer.style.display = 'block';
          }
          return;
      }

      processAndDisplayHistory(historyData);
      
       if (sensorDetailsContainer.style.display === 'none') {
            loadingMessage.style.display = 'none';
            errorMessage.style.display = 'none';
            sensorDetailsContainer.style.display = 'block';
        }

    } catch (error) {
      console.error('[details_capteur] Erreur lors du chargement de l\'historique:', error);
      showError(`Impossible de charger l\'historique pour nano${nanoId}.`);
    }
  }

  function processAndDisplayHistory(data) {
    chartsHistoryContainer.innerHTML = ''; 

    let metricsToChart;
    if (nanoId === '1') {
        metricsToChart = ['voltage', 'current', 'lux'];
    } else {
        metricsToChart = ['lux', 'temp_air', 'hum_air', 'hum_sol'];
    }
    
    metricsToChart.forEach(metricKey => {
      const relevantData = data.filter(d => d[metricKey] !== null && d[metricKey] !== undefined);

      if (relevantData.length > 0) {
        const chartData = relevantData.map(row => ({
          x: row.ts_device_ms, 
          y: row[metricKey]
        })); 

        createHistoryChart(metricKey, LABELS[metricKey] || metricKey, chartData);

      } else {
          console.warn(`[details_capteur] Pas de données valides ou métrique ${metricKey} non trouvée dans l\'historique pour nano${nanoId}`);
      }
    });
  }

  function createHistoryChart(metricKey, label, data) {
    const chartCard = document.createElement('div');
    chartCard.className = 'chart-card';
    
    const title = document.createElement('h4');
    title.textContent = `Historique ${label}`;
    chartCard.appendChild(title);

    const canvas = document.createElement('canvas');
    chartCard.appendChild(canvas);
    chartsHistoryContainer.appendChild(chartCard);

    historyCharts[metricKey] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        datasets: [{
          label: label,
          data: data,
          borderColor: METRIC_COLORS[metricKey] || randColor(),
          borderWidth: 1.5,
          tension: 0.3,
          pointRadius: 0, 
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false, 
        scales: {
          x: {
            type: 'time',
            time: {
              unit: 'minute',
              tooltipFormat: 'dd/MM/yy HH:mm:ss', 
              displayFormats: { 
                minute: 'HH:mm',
                hour: 'dd/MM HH:mm',
                day: 'dd/MM/yy'
              }
            },
            title: {
              display: true,
              text: 'Temps'
            }
          },
          y: {
            beginAtZero: (metricKey === 'current') ? undefined : false,
            title: {
              display: true,
              text: label
            }
          }
        },
        plugins: {
          legend: {
            display: true,
            position: 'top'
          },
          tooltip: {
            mode: 'index',
            intersect: false,
          }
        },
        animation: {
            duration: 0 
        }
      }
    });
  }

  /* === UTILS =========================================================== */
  const fmtValue = (k, v) => {
    if (typeof v !== 'number' || isNaN(v)) return 'N/A';
    return v.toFixed(DEC[k] ?? 0);
  }
  const randColor = () => `hsl(${Math.floor(Math.random() * 360)}, 70%, 50%)`;
  const fmtTime = t => {
    if (!t) return '…';
    const d = new Date(t);
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  /* === START =========================================================== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
