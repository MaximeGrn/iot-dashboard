/*
 * generale.js
 * -------------------------------------------------------------
 * • Calcule et affiche les moyennes des données de tous les capteurs (nano2+)
 * • Utilise la même connexion MQTT que le dashboard
 * • Exclut volontairement nano1 (Moniteur Batterie) des calculs
 * • Utilise sessionStorage pour conserver les données pendant la session
 */

(() => {
  /* === CONFIG ========================================================== */
  const brokerUrl   = 'ws://10.42.0.1:9001/mqtt';
  const credentials = { username: 'maxime', password: 'Eseo2025' };
  const CHECK_EVERY = 1_000;           // vérif chaque seconde
  const TIMEOUT     = 3_000;           // au‑delà de 3 s sans trame ➜ offline
  const SAVE_INTERVAL = 3_000;         // sauvegarde dans sessionStorage toutes les 5 secondes
  const CLEANUP_INTERVAL = 2_000;     // nettoyage des capteurs inactifs toutes les 10 secondes

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
  
  /* === SESSION STORAGE ================================================= */
  function saveToSessionStorage() {
    try {
      // Structure des données à sauvegarder
      const dataToSave = {
        avgData: { ...avgData },
        chartData: {},
        timestamp: Date.now()
      };
      
      // Sauvegarde des données des graphiques
      for (const metric in charts) {
        if (charts[metric] && charts[metric].data && charts[metric].data.datasets[0]) {
          dataToSave.chartData[metric] = charts[metric].data.datasets[0].data;
        }
      }
      
      // Conversion en string JSON et sauvegarde
      sessionStorage.setItem('generale_data', JSON.stringify(dataToSave));
      console.log('[generale] Données sauvegardées dans sessionStorage');
    } catch (e) {
      console.warn('[generale] Erreur lors de la sauvegarde dans sessionStorage:', e);
    }
  }
  
  function loadFromSessionStorage() {
    try {
      const savedData = sessionStorage.getItem('generale_data');
      if (!savedData) return false;
      
      const data = JSON.parse(savedData);
      if (!data || !data.avgData) return false;
      
      console.log('[generale] Chargement des données depuis sessionStorage');
      
      // Restauration des données moyennes
      Object.assign(avgData, data.avgData);
      
      // Mise à jour de l'interface avec les données chargées
      if (avgData.online) {
        statusEl.textContent = avgData.statusText || '🟢 Données restaurées depuis cache';
        statusEl.style.color = '#2a9d3c';
        
        // Mise à jour des métriques textuelles
        for (const metric in avgData) {
          if (metric === 'online' || metric === 'timestamp' || metric === 'statusText' || 
              metric.startsWith('prox') || metric === 'datetime_str') continue;
          
          updateMetric(metric, avgData[metric], avgData.timestamp, false);
        }
        
        // Restauration des données des graphiques
        if (data.chartData) {
          for (const metric in data.chartData) {
            if (data.chartData[metric] && data.chartData[metric].length > 0) {
              updateChartFromCache(metric, data.chartData[metric]);
            }
          }
        }
      }
      
      return true;
    } catch (e) {
      console.warn('[generale] Erreur lors du chargement depuis sessionStorage:', e);
      return false;
    }
  }
  
  function updateChartFromCache(metric, dataPoints) {
    const label = LABELS[metric] || metric;
    
    // Création du graphique s'il n'existe pas déjà
    let chart = charts[metric];
    if (!chart) {
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
    
    // Restauration des données
    chart.data.datasets[0].data = dataPoints;
    chart.update('none');
  }
  
  // Sauvegarde périodique des données
  setInterval(saveToSessionStorage, SAVE_INTERVAL);
  
  // Sauvegarde des données avant de quitter la page
  window.addEventListener('beforeunload', saveToSessionStorage);
  
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
      sensors[key] = { lastSeen: Date.now(), data: {}, active: true };
    } else {
      sensors[key].lastSeen = Date.now();
      sensors[key].active = true;
    }
    
    // Stockage des données
    sensors[key].data = { ...sensors[key].data, ...data };
    
    // Calcul des moyennes à partir des capteurs connectés
    calculateAverages();
    
    // Mise à jour de l'interface
    updateUI();
  });

  /* === NETTOYAGE DES CAPTEURS INACTIFS ================================= */
  function cleanupInactiveSensors() {
    const now = Date.now();
    let changeDetected = false;
    
    for (const [key, sensor] of Object.entries(sensors)) {
      // Marquer explicitement les capteurs inactifs
      if (now - sensor.lastSeen >= TIMEOUT && sensor.active) {
        sensor.active = false;
        changeDetected = true;
        console.log(`[generale] Capteur ${key} marqué comme inactif`);
      }
    }
    
    // Si des changements ont été détectés, recalculer les moyennes
    if (changeDetected) {
      calculateAverages();
      updateUI();
    }
  }
  
  // Nettoyage périodique des capteurs inactifs
  setInterval(cleanupInactiveSensors, CLEANUP_INTERVAL);

  /* === CALCUL DES MOYENNES =================================================== */
  function calculateAverages() {
    const now = Date.now();
    const activeSensors = [];
    
    // Filtrage des capteurs actifs avec vérification stricte
    for (const [key, sensor] of Object.entries(sensors)) {
      // Vérification stricte: timestamp récent ET marqué comme actif
      if (now - sensor.lastSeen < TIMEOUT) {
        sensor.active = true; // S'assurer que l'état est correct
        activeSensors.push(sensor);
      } else {
        // Marquer explicitement comme inactif
        sensor.active = false;
      }
    }
    
    // Vérification du nombre réel de capteurs actifs
    const realActiveSensorsCount = Object.values(sensors).filter(s => s.active).length;
    
    // S'il n'y a pas de capteur actif, on ne peut pas calculer de moyenne
    if (realActiveSensorsCount === 0) {
      avgData.online = false;
      statusEl.textContent = '🔴 Aucun capteur actif';
      statusEl.style.color = '#d33';
      return;
    }
    
    // Initialisation des compteurs pour chaque métrique
    const sums = {};
    const counts = {};
    
    // Calcul des sommes uniquement avec les capteurs VRAIMENT actifs
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
    
    // Texte du statut avec le nombre correct de capteurs actifs
    const statusText = `🟢 Moyenne de ${realActiveSensorsCount} capteur${realActiveSensorsCount > 1 ? 's' : ''} actif${realActiveSensorsCount > 1 ? 's' : ''}`;
    avgData.statusText = statusText;
    
    // Mise à jour du statut
    statusEl.textContent = statusText;
    statusEl.style.color = '#2a9d3c';
  }

  /* === UI UPDATE ======================================================= */
  function updateUI() {
    if (!avgData.online) return;
    
    const timestamp = avgData.timestamp;
    
    // Mise à jour des métriques textuelles
    for (const [metric, value] of Object.entries(avgData)) {
      if (metric === 'online' || metric === 'timestamp' || metric === 'statusText' || 
          metric.startsWith('prox') || metric === 'datetime_str') continue;
      
      updateMetric(metric, value, timestamp, true);
    }
  }
  
  function updateMetric(metric, value, timestamp, shouldSave = true) {
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
    
    // Ajout du point de données seulement si ce n'est pas un chargement depuis cache
    if (shouldSave) {
      const dataset = chart.data.datasets[0];
      dataset.data.push({ x: timestamp, y: value });
      
      // Limitation à 300 points pour éviter de surcharger
      if (dataset.data.length > 300) dataset.data.shift();
    }
    
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
  
  // Tentative de restauration des données depuis sessionStorage au chargement
  if (!loadFromSessionStorage()) {
    console.log('[generale] Aucune donnée en cache, attente de nouvelles données MQTT');
  }
})(); 