(function () {
  const PANEL = document.getElementById('spot-notification-panel');
  const SELECT = document.getElementById('spot-zone-select');
  const BUTTON = document.getElementById('spot-notify-button');
  const STATUS = document.getElementById('spot-notify-status');
  const LAST = document.getElementById('spot-notify-last');

  const ZONES = [
    'AT','BE','BG','CH','CZ','DE_LU','DK1','DK2','EE','ES','FI','FR','GR','HR','HU','IT-CALABRIA','IT-CENTRE_NORTH','IT-CENTRE_SOUTH','IT-NORTH','IT-SARDINIA','IT-SICILY','IT-SOUTH','LT','LV','NL','NO1','NO2','NO3','NO4','NO5','PL','PT','RO','RS','SE1','SE2','SE3','SE4','SI','SK'
  ].sort();
  const SYNC_TAG = 'spot-latest-sync';
  const PERIOD_MS = 15 * 60 * 1000;
  const JITTER_MS = 5 * 60 * 1000;

  let swReadyPromise = null;
  let currentZone = null;
  let lastTimestamp = null;
  let fallbackTimer = null;
  let periodicRegistered = false;

  if (!PANEL || !SELECT || !BUTTON) {
    if ('serviceWorker' in navigator && !swReadyPromise) {
      swReadyPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null);
    }
    if (PANEL) {
      PANEL.style.display = 'none';
    }
    console.warn('Price notifications hidden: required UI elements not found.');
    return;
  }

  function populateZones() {
    SELECT.innerHTML = '<option value="">Select bidding zone</option>';
    for (const zone of ZONES) {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = zone;
      SELECT.appendChild(option);
    }
  }

  function updateButtonLabel() {
    BUTTON.textContent = currentZone ? 'Disable alerts' : 'Enable alerts';
  }

  function updateStatus(message) {
    if (STATUS) STATUS.textContent = message;
  }

  function updateLastSeen(timestamp) {
    lastTimestamp = timestamp || null;
    if (!LAST) return;
    if (!timestamp) {
      LAST.textContent = '';
      return;
    }
    try {
      const date = new Date(timestamp);
      const formatted = date.toLocaleString('en-GB', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      LAST.textContent = `Last seen: ${formatted} UTC`;
    } catch (_) {
      LAST.textContent = `Last seen: ${timestamp}`;
    }
  }

  function computeDelay() {
    return PERIOD_MS + Math.floor(Math.random() * JITTER_MS);
  }

  function stopFallback() {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function scheduleFallback() {
    stopFallback();
    const schedule = () => {
      fallbackTimer = setTimeout(async () => {
        await sendMessage({ type: 'trigger-poll', skipDelay: true });
        schedule();
      }, computeDelay());
    };
    schedule();
  }

  function clearBadge() {
    if (navigator && navigator.clearAppBadge) {
      navigator.clearAppBadge().catch(() => {});
    }
  }

  function setZoneValue(zone) {
    currentZone = zone || null;
    if (SELECT) {
      SELECT.value = zone || '';
    }
    updateButtonLabel();
  }

  async function ensureServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers are not supported in this browser.');
    }
    if (!swReadyPromise) {
      swReadyPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(() => navigator.serviceWorker.ready);
    }
    return swReadyPromise;
  }

  async function getController() {
    await ensureServiceWorker();
    if (navigator.serviceWorker.controller) {
      return navigator.serviceWorker.controller;
    }
    return await new Promise(resolve => {
      navigator.serviceWorker.addEventListener('controllerchange', function listener() {
        navigator.serviceWorker.removeEventListener('controllerchange', listener);
        resolve(navigator.serviceWorker.controller);
      });
    });
  }

  async function sendMessage(message) {
    try {
      const controller = await getController();
      if (controller) {
        controller.postMessage(message);
      }
    } catch (error) {
      console.warn('Unable to communicate with service worker', error);
    }
  }

  async function registerPeriodicSync() {
    periodicRegistered = false;
    try {
      const registration = await ensureServiceWorker();
      if ('periodicSync' in registration) {
        try {
          if (navigator.permissions && navigator.permissions.query) {
            try {
              const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
              if (status.state === 'denied') {
                throw new Error('Periodic background sync permission denied');
              }
            } catch (_) {
              // ignore unsupported permission queries
            }
          }
          await registration.periodicSync.register(SYNC_TAG, { minInterval: PERIOD_MS });
          periodicRegistered = true;
        } catch (err) {
          console.warn('Periodic Background Sync registration failed', err);
          periodicRegistered = false;
        }
      }
    } catch (err) {
      periodicRegistered = false;
    }
    return periodicRegistered;
  }

  async function unregisterPeriodicSync() {
    try {
      const registration = await ensureServiceWorker();
      if ('periodicSync' in registration) {
        const tags = await registration.periodicSync.getTags();
        if (tags.includes(SYNC_TAG)) {
          await registration.periodicSync.unregister(SYNC_TAG);
        }
      }
    } catch (err) {
      console.warn('Unable to unregister periodic sync', err);
    }
  }

  async function enableAlerts() {
    const zone = SELECT.value;
    if (!zone) {
      updateStatus('Choose a bidding zone to enable alerts.');
      return;
    }
    try {
      await ensureServiceWorker();
    } catch (err) {
      updateStatus('Service workers are not supported in this browser.');
      return;
    }

    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        updateStatus('Notifications are blocked. Enable them to receive alerts.');
        return;
      }
    } else {
      updateStatus('Notifications are not supported in this browser.');
    }

    setZoneValue(zone);
    updateStatus('Alerts enabled. We will check for new prices...');
    clearBadge();

    await sendMessage({ type: 'set-zone', zone });
    const periodic = await registerPeriodicSync();
    if (periodic) {
      updateStatus(`Background polling scheduled for ${zone}.`);
      stopFallback();
    } else {
      updateStatus(`Background polling not available; keeping a foreground refresher for ${zone}.`);
      scheduleFallback();
    }
    await sendMessage({ type: 'trigger-poll', skipDelay: true });
  }

  async function disableAlerts() {
    await sendMessage({ type: 'set-zone', zone: null });
    await sendMessage({ type: 'clear-badge' });
    setZoneValue(null);
    updateStatus('Alerts disabled.');
    updateLastSeen(null);
    stopFallback();
    await unregisterPeriodicSync();
    clearBadge();
  }

  function handleButtonClick() {
    if (currentZone) {
      disableAlerts();
    } else {
      enableAlerts();
    }
  }

  function setupMessageChannel() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', event => {
      const data = event.data || {};
      if (data.type === 'state' && data.state) {
        setZoneValue(data.state.zone || null);
        updateLastSeen(data.state.lastTimestamp || null);
        if (currentZone) {
          registerPeriodicSync().then(success => {
            if (!success) {
              scheduleFallback();
            } else {
              stopFallback();
            }
          });
          updateStatus(`Alerts active for ${currentZone}.`);
        } else {
          updateStatus('Choose a bidding zone to enable alerts.');
          stopFallback();
        }
      } else if (data.type === 'state-updated' && data.state) {
        if (currentZone === data.state.zone) {
          updateLastSeen(data.state.lastTimestamp || null);
        }
     } else if (data.type === 'new-prices') {
        if (data.zone === currentZone) {
          updateLastSeen(data.timestamp);
        }
        updateStatus(`New day-ahead prices for ${data.zone}!`);
        clearBadge();
        sendMessage({ type: 'clear-badge' });
      } else if (data.type === 'focus-zone' && data.zone) {
        if (SELECT) {
          SELECT.value = data.zone;
        }
      }
    });
  }

  async function bootstrap() {
    populateZones();
    updateButtonLabel();
    updateStatus('Choose a bidding zone to enable alerts.');

    if (!('serviceWorker' in navigator)) {
      if (PANEL) PANEL.style.display = 'none';
      console.warn('Price notifications hidden: this browser does not support service workers.');
      return;
    }

    try {
      await ensureServiceWorker();
      setupMessageChannel();
      await sendMessage({ type: 'request-state' });
    } catch (err) {
      console.warn('Service worker registration failed', err);
      if (PANEL) PANEL.style.display = 'none';
      console.warn('Price notifications hidden: service worker registration failed.');
      return;
    }
  }

  BUTTON.addEventListener('click', handleButtonClick);
  SELECT.addEventListener('change', () => {
    if (currentZone && SELECT.value !== currentZone) {
      handleButtonClick(); // disable existing
      if (SELECT.value) {
        enableAlerts();
      }
    }
  });
  bootstrap();
})();
