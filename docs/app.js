(() => {
  const devPanel = document.getElementById('spot-dev-panel');
  if (!devPanel) {
    return;
  }

  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  const NGROK_PATTERN = /(?:\.ngrok(?:-free)?\.app|ngrok\.io)$/i;
  const host = location.hostname;
  const isDevHost = LOCAL_HOSTS.has(host) || NGROK_PATTERN.test(host);

  const HARNESS_FLAG_KEY = 'spot.dev.harnessEnabled';
  const search = new URLSearchParams(location.search);
  const devParam = search.get('dev-harness');

  if (devParam !== null) {
    const shouldDisable = ['0', 'false', 'off', 'no'].includes(devParam.toLowerCase());
    try {
      if (shouldDisable) {
        localStorage.removeItem(HARNESS_FLAG_KEY);
      } else {
        localStorage.setItem(HARNESS_FLAG_KEY, '1');
      }
    } catch (_) {
      // ignore storage errors (private mode etc.)
    }
  }

  let storedHarnessEnabled = false;
  try {
    storedHarnessEnabled = localStorage.getItem(HARNESS_FLAG_KEY) === '1';
  } catch (_) {
    storedHarnessEnabled = false;
  }

  const harnessEnabled = isDevHost || storedHarnessEnabled;

  if (!harnessEnabled) {
    try {
      window.enableSpotHarness = () => {
        try {
          localStorage.setItem(HARNESS_FLAG_KEY, '1');
        } catch (_) {
          // swallow storage failures
        }
        location.reload();
      };
      window.disableSpotHarness = () => {
        try {
          localStorage.removeItem(HARNESS_FLAG_KEY);
        } catch (_) {
          // swallow storage failures
        }
        location.reload();
      };
    } catch (_) {
      // window might be undefined in some embeddings
    }
    return;
  }

  devPanel.classList.remove('hidden');
  const requestButton = document.getElementById('dev-request-permission');
  const pollButton = document.getElementById('dev-trigger-poll');
  const notifyButton = document.getElementById('dev-force-notify');
  const clearButton = document.getElementById('dev-clear-badge');
  const originSelect = document.getElementById('dev-data-origin');
  const zoneEl = document.getElementById('dev-state-zone');
  const tsEl = document.getElementById('dev-state-timestamp');
  const modeEl = document.getElementById('dev-state-mode');
  const originEl = document.getElementById('dev-state-origin');
  const statusEl = document.getElementById('dev-status');

  const ORIGIN_PRESETS = {
    remote: 'https://spot.utilitarian.io',
    local: ''
  };
  const DEFAULT_ORIGIN_PRESET = 'remote';
  const ORIGIN_STORAGE_KEY = 'spot.dev.originPreset';
  const SYNC_TAG = 'spot-latest-sync';

  const readStoredPreset = () => {
    try {
      return localStorage.getItem(ORIGIN_STORAGE_KEY);
    } catch (_) {
      return null;
    }
  };

  const persistOriginPreset = preset => {
    try {
      localStorage.setItem(ORIGIN_STORAGE_KEY, preset);
    } catch (_) {
      // ignore storage issues (e.g. private mode)
    }
  };

  const storedPreset = originSelect ? readStoredPreset() : null;
  const initialPreset = storedPreset && Object.prototype.hasOwnProperty.call(ORIGIN_PRESETS, storedPreset)
    ? storedPreset
    : DEFAULT_ORIGIN_PRESET;

  if (originSelect && originSelect.value !== initialPreset) {
    originSelect.value = initialPreset;
  }

  const state = {
    zone: null,
    lastTimestamp: null,
    origin: ORIGIN_PRESETS[initialPreset]
  };

  let currentMode = 'fallback';
  let statusTimeout = null;
  let swReadyPromise = null;
  let controllerPromise = null;
  let modeIntervalId = null;

  const setStatus = message => {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message || '';
    if (statusTimeout) {
      clearTimeout(statusTimeout);
      statusTimeout = null;
    }
    if (message) {
      statusTimeout = setTimeout(() => {
        if (statusEl.textContent === message) {
          statusEl.textContent = '';
        }
        statusTimeout = null;
      }, 4000);
    }
  };

  const formatTimestamp = value => {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return `${date.toLocaleString('en-GB', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })} UTC`;
    }
    return String(value);
  };

  const presetForOrigin = origin => (origin && origin === ORIGIN_PRESETS.remote ? 'remote' : 'local');

  const describeOrigin = origin => (origin
    ? `Remote (${origin})`
    : `Local files (${location.origin})`);

  const buildDisplayUrl = zone => {
    if (!zone) {
      return '';
    }
    const base = state.origin || location.origin;
    return `${base}/electricity/${encodeURIComponent(zone)}/latest/index.json`;
  };

  const updateDisplay = () => {
    if (zoneEl) {
      zoneEl.textContent = state.zone || '—';
    }
    if (tsEl) {
      tsEl.textContent = formatTimestamp(state.lastTimestamp);
    }
    if (modeEl) {
      modeEl.textContent = currentMode;
    }
    if (originEl) {
      originEl.textContent = describeOrigin(state.origin);
    }
    if (originSelect) {
      const preset = presetForOrigin(state.origin);
      if (originSelect.value !== preset) {
        originSelect.value = preset;
      }
    }
  };

  const ensureServiceWorker = async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers are not supported in this browser.');
    }
    if (!swReadyPromise) {
      swReadyPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .catch(err => {
          setStatus('Service worker registration failed.');
          throw err;
        })
        .then(() => navigator.serviceWorker.ready);
    }
    return swReadyPromise;
  };

  const waitForController = () => {
    if (navigator.serviceWorker.controller) {
      return Promise.resolve(navigator.serviceWorker.controller);
    }
    if (!controllerPromise) {
      controllerPromise = new Promise(resolve => {
        const listener = () => {
          navigator.serviceWorker.removeEventListener('controllerchange', listener);
          resolve(navigator.serviceWorker.controller);
        };
        navigator.serviceWorker.addEventListener('controllerchange', listener);
      });
    }
    return controllerPromise;
  };

  const withController = async callback => {
    await ensureServiceWorker();
    const controller = navigator.serviceWorker.controller || await waitForController();
    if (!controller) {
      throw new Error('Service worker controller unavailable.');
    }
    return callback(controller);
  };

  const sendMessage = async message => {
    try {
      await withController(controller => controller.postMessage(message));
    } catch (err) {
      console.warn('Dev harness: failed to communicate with service worker', err);
      setStatus('Could not reach service worker.');
    }
  };

  const updateMode = async () => {
    try {
      const registration = await ensureServiceWorker();
      if (registration?.periodicSync?.getTags) {
        const tags = await registration.periodicSync.getTags();
        currentMode = tags.includes(SYNC_TAG) ? 'periodic' : 'fallback';
      } else {
        currentMode = 'fallback';
      }
    } catch (_) {
      currentMode = 'fallback';
    }
    updateDisplay();
  };

  const handleMessage = event => {
    const data = event.data || {};
    switch (data.type) {
      case 'state':
      case 'state-updated':
        if (data.state) {
          const incomingOrigin = typeof data.state.origin === 'string'
            ? data.state.origin
            : state.origin;
          if (incomingOrigin !== state.origin) {
            state.origin = incomingOrigin;
            persistOriginPreset(presetForOrigin(state.origin));
          }
          state.zone = data.state.zone || null;
          state.lastTimestamp = data.state.lastTimestamp || null;
          updateDisplay();
          if (state.zone) {
            setStatus(`Watching ${state.zone} (${buildDisplayUrl(state.zone)})`);
          } else {
            setStatus('Choose a zone to enable alerts.');
          }
        }
        break;
      case 'new-prices':
        if (data.timestamp) {
          state.lastTimestamp = data.timestamp;
          updateDisplay();
        }
        if (data.zone) {
          setStatus(`New day-ahead prices for ${data.zone}!`);
        }
        break;
      default:
        break;
    }
  };

  const bindEvents = () => {
    if (requestButton) {
      requestButton.addEventListener('click', async () => {
        if (!('Notification' in window)) {
          setStatus('Notifications are not supported in this browser.');
          return;
        }
        try {
          const result = await Notification.requestPermission();
          setStatus(`Notification permission: ${result}`);
        } catch (err) {
          console.warn('Notification permission request failed', err);
          setStatus('Notification permission request failed.');
        }
      });
    }

    if (pollButton) {
      pollButton.addEventListener('click', async () => {
        await sendMessage({ type: 'trigger-poll', skipDelay: true });
        setStatus('Requested immediate poll.');
      });
    }

    if (notifyButton) {
      notifyButton.addEventListener('click', async () => {
        await sendMessage({ type: 'dev-notify' });
        setStatus('Dev notification requested.');
      });
    }

    if (clearButton) {
      clearButton.addEventListener('click', async () => {
        navigator.clearAppBadge?.();
        await sendMessage({ type: 'clear-badge' });
        setStatus('Badge cleared.');
      });
    }

    if (originSelect) {
      originSelect.addEventListener('change', async () => {
        const preset = originSelect.value && Object.prototype.hasOwnProperty.call(ORIGIN_PRESETS, originSelect.value)
          ? originSelect.value
          : DEFAULT_ORIGIN_PRESET;
        state.origin = ORIGIN_PRESETS[preset];
        persistOriginPreset(preset);
        updateDisplay();
        await sendMessage({ type: 'set-data-origin', origin: state.origin });
        setStatus(`Data source set to ${describeOrigin(state.origin)}`);
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        try {
          navigator.clearAppBadge?.();
        } catch (_) {
          // ignore
        }
      }
    });
  };

  const init = async () => {
    bindEvents();

    if (!('serviceWorker' in navigator)) {
      setStatus('Service workers are not available.');
      return;
    }

    navigator.serviceWorker.addEventListener('message', handleMessage);
    updateDisplay();
    setStatus(`Data source set to ${describeOrigin(state.origin)}`);

    await ensureServiceWorker();
    await sendMessage({ type: 'set-data-origin', origin: state.origin });
    await sendMessage({ type: 'request-state' });
    await updateMode();

    if (!modeIntervalId) {
      modeIntervalId = window.setInterval(updateMode, 15000);
    }
  };

  init().catch(err => {
    console.warn('Dev harness initialisation failed', err);
    setStatus('Dev harness failed to initialise.');
  });
})();
