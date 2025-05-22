/*
 * generale.js
 * -------------------------------------------------------------
 * • Calcule et affiche les moyennes des données de tous les capteurs (nano2+)
 * • Utilise la même connexion MQTT que le dashboard
 * • Exclut volontairement nano1 (Moniteur Batterie) des calculs
 */

(() => {
  /* === CONFIG ========================================================== */
  const brokerUrl   = 'ws://10.42.0.1:9001/mqtt';
  const credentials = { username: 'maxime', password: 'Eseo2025' };
  const CHECK_EVERY = 1_000;           // vérif chaque seconde
  const TIMEOUT     = 3_000;           // au‑delà de 3 s sans trame ➜ offline

  /* === DOM ============================================================ */
  const averageCard = document.querySelector('#average-container .nano-card');
  const metricsGrid = averageCard.querySelector('.metrics-grid');
  const chartsContainer = averageCard.querySelector('.charts-container');
  const statusEl = averageCard.querySelector('.status');
  
  if (typeof Chart !== 'undefined') {
    Chart.defaults.locale = 'fr-FR';
  }

  /* === STATE =========================================================== */
  const sensors = {}; // Contiendra les données de tous les capteurs sauf nano1
  const avgData = {}; // Contiendra les moyennes calculées
  const charts = {}; // Contiendra les instances des graphiques
  
  /* === MQTT ============================================================ */
  const client = mqtt.connect(brokerUrl, credentials);

  client.on('connect', () => {
    console.log('[generale] MQTT connected');
    client.subscribe('#');
    statusEl.textContent = '🟢 Connecté au broker MQTT';
    statusEl.style.color = '#2a9d3c';
  });
  
  client.on('error', (error) => {
    console.error('[generale] MQTT error:', error);
    statusEl.textContent = '🔴 Erreur de connexion MQTT';
    statusEl.style.color = '#d33';
  });

  client.on('message', (topic, payload, packet) => {
    const m = /^nano(\d+)\/telemetry$/.exec(topic);
    if (!m) return;
    
    const nanoId = m[1];
    const nanoNum = parseInt(nanoId);
    
    // On ignore nano1 (Moniteur de batterie)
    if (nanoNum === 1) return;
    
    const key = `nano${nanoId}`;
    let data;
    try { 
      data = JSON.parse(payload.toString());
    } catch { 
      return console.warn('payload JSON invalide :', payload.toString()); 
    }
    
    // Mise à jour des données du capteur
    if (!sensors[key]) {
      sensors[key] = { lastSeen: Date.now(), data: {} };
    } else {
      sensors[key].lastSeen = Date.now();
    }
    
    // Stockage des données
    sensors[key].data = { ...sensors[key].data, ...data };
    
    // Calcul des moyennes à partir des capteurs connectés
    calculateAverages();
    
    // Mise à jour de l'interface
    updateUI();
  });

  /* === CALCUL DES MOYENNES =================================================== */
  function calculateAverages() {
    const now = Date.now();
    const activeSensors = [];
    
    // Filtrage des capteurs actifs (vus dans les 3 dernières secondes)
    for (const [key, sensor] of Object.entries(sensors)) {
      if (now - sensor.lastSeen < TIMEOUT) {
        activeSensors.push(sensor);
      }
    }
    
    // S'il n'y a pas de capteur actif, on ne peut pas calculer de moyenne
    if (activeSensors.length === 0) {
      avgData.online = false;
      statusEl.textContent = '🔴 Aucun capteur actif';
      statusEl.style.color = '#d33';
      return;
    }
    
    // Initialisation des compteurs pour chaque métrique
    const sums = {};
    const counts = {};
    
    // Calcul des sommes
    for (const sensor of activeSensors) {
      for (const [metric, value] of Object.entries(sensor.data)) {
        // On ignore les métriques non numériques ou spéciales
        if (metric === 'datetime_str' || metric.startsWith('prox') || typeof value !== 'number') {
          continue;
        }
        
        if (!sums[metric]) {
          sums[metric] = 0;
          counts[metric] = 0;
        }
        
        sums[metric] += value;
        counts[metric]++;
      }
    }
    
    // Calcul des moyennes
    for (const metric in sums) {
      avgData[metric] = counts[metric] ? sums[metric] / counts[metric] : 0;
    }
    
    avgData.online = true;
    avgData.timestamp = now;
    
    // Mise à jour du statut
    statusEl.textContent = `🟢 Moyenne de ${activeSensors.length} capteur${activeSensors.length > 1 ? 's' : ''} actif${activeSensors.length > 1 ? 's' : ''}`;
    statusEl.style.color = '#2a9d3c';
  }

  /* === UI UPDATE ======================================================= */
  function updateUI() {
    if (!avgData.online) return;
    
    const timestamp = avgData.timestamp;
    
    // Mise à jour des métriques textuelles
    for (const [metric, value] of Object.entries(avgData)) {
      if (metric === 'online' || metric === 'timestamp' || metric.startsWith('prox') || metric === 'datetime_str') continue;
      
      updateMetric(metric, value, timestamp);
    }
  }
  
  function updateMetric(metric, value, timestamp) {
    const label = LABELS[metric] || metric;
    
    // Mise à jour du texte
    let metricEl = metricsGrid.querySelector(`[data-metric="${metric}"]`);
    if (!metricEl) {
      metricEl = document.createElement('div');
      metricEl.dataset.metric = metric;
      metricEl.innerHTML = `<span class="metric-label">${label}: </span><span class="metric-value"></span>`;
      metricsGrid.appendChild(metricEl);
    }
    
    metricEl.querySelector('.metric-value').textContent = formatValue(metric, value);
    
    // Mise à jour du graphique
    let chart = charts[metric];
    if (!chart) {
      // Création du graphique s'il n'existe pas
      const canvas = document.createElement('canvas');
      canvas.style.height = '150px';
      canvas.style.width = '100%';
      chartsContainer.appendChild(canvas);
      
      chart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          datasets: [{
            label: label,
            data: [],
            borderColor: METRIC_COLORS[metric] || getRandomColor(),
            borderWidth: 1,
            tension: 0.25,
            pointRadius: 0
          }]
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: true,
          scales: {
            x: {
              type: 'time',
              time: {
                unit: 'minute',
                displayFormats: {
                  minute: 'HH:mm',
                  hour: 'HH:mm'
                }
              }
            },
            y: { beginAtZero: true }
          },
          plugins: {
            legend: { display: true, position: 'top' }
          }
        }
      });
      charts[metric] = chart;
    }
    
    // Ajout du point de données
    const dataset = chart.data.datasets[0];
    dataset.data.push({ x: timestamp, y: value });
    
    // Limitation à 300 points pour éviter de surcharger
    if (dataset.data.length > 300) dataset.data.shift();
    
    chart.update('none');
  }

  /* === UTILS =========================================================== */
  const LABELS = { 
    voltage: 'Tension (V)', 
    current: 'Courant (A)', 
    lux: 'Luminosité (lx)', 
    temp_air: 'Temp. Air (°C)', 
    hum_air: 'Hum. Air (%)', 
    hum_sol: 'Hum. Sol (%)' 
  };
  
  const DEC = { 
    voltage: 2, 
    current: 2, 
    temp_air: 1 
  };
  
  const METRIC_COLORS = {
    voltage: '#FFD700',  // Or
    current: '#4682B4',  // Bleu acier
    lux: '#FFA500',      // Orange
    temp_air: '#007BFF', // Bleu
    hum_air: '#32CD32',  // Vert lime
    hum_sol: '#8B4513'   // Marron
  };
  
  function formatValue(metric, value) {
    return value.toFixed(DEC[metric] || 0);
  }
  
  function getRandomColor() {
    return `hsl(${Math.floor(Math.random() * 360)}, 70%, 50%)`;
  }
  
  // Lancement du calcul périodique des moyennes
  setInterval(calculateAverages, CHECK_EVERY);
})(); 