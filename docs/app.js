(() => {
  // ---------------------------------------------------------------------------
  // Dev Notification Harness
  // ---------------------------------------------------------------------------
  // This script powers the optional dev panel that helps us exercise the
  // notification service worker while developing. It lets us:
  //   • request Notification permission explicitly
  //   • send a synthetic “dev notification” through the SW
  //   • clear the app badge
  //   • switch the data origin used by the SW (production / local / custom)
  // The panel is hidden by default and only becomes visible on localhost,
  // ngrok tunnels, or when `?dev-harness=1` is appended to the URL.
  // ---------------------------------------------------------------------------

  const devPanel = document.getElementById('spot-dev-panel');
  if (!devPanel) return;

  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  const NGROK_PATTERN = /(?:\.ngrok(?:-free)?\.app|ngrok\.io)$/i;
  const host = location.hostname;
  const isDevHost = LOCAL_HOSTS.has(host) || NGROK_PATTERN.test(host);

  const HARNESS_FLAG_KEY = 'spot.dev.harnessEnabled';
  const search = new URLSearchParams(location.search);
  const flagParam = search.get('dev-harness');

  if (flagParam !== null) {
    const disable = ['0', 'false', 'off', 'no'].includes(flagParam.toLowerCase());
    try {
      if (disable) {
        localStorage.removeItem(HARNESS_FLAG_KEY);
      } else {
        localStorage.setItem(HARNESS_FLAG_KEY, '1');
      }
    } catch (_) {
      // ignore storage failures (private browsing, etc.)
    }
  }

  let harnessEnabled = isDevHost;
  if (!harnessEnabled) {
    try {
      harnessEnabled = localStorage.getItem(HARNESS_FLAG_KEY) === '1';
    } catch (_) {
      harnessEnabled = false;
    }
  }

  if (!harnessEnabled) {
    try {
      window.enableSpotHarness = () => {
        try { localStorage.setItem(HARNESS_FLAG_KEY, '1'); } catch (_) {}
        location.reload();
      };
      window.disableSpotHarness = () => {
        try { localStorage.removeItem(HARNESS_FLAG_KEY); } catch (_) {}
        location.reload();
      };
    } catch (_) {
      // ignore – window may not exist in some embeddings
    }
    return;
  }

  devPanel.classList.remove('hidden');

  /* ------------------------------------------------------------------------ */
  /* Elements                                                                 */
  /* ------------------------------------------------------------------------ */

  const requestButton = document.getElementById('dev-request-permission');
  const notifyButton = document.getElementById('dev-force-notify');
  const clearButton = document.getElementById('dev-clear-badge');
  const originSelect = document.getElementById('dev-data-origin');
  const customOriginWrap = document.getElementById('dev-data-origin-custom-wrap');
  const customOriginInput = document.getElementById('dev-data-origin-custom');
  const zoneEl = document.getElementById('dev-state-zone');
  const tsEl = document.getElementById('dev-state-timestamp');
  const originEl = document.getElementById('dev-state-origin');
  const statusEl = document.getElementById('dev-status');

  const ORIGIN_PRESETS = {
    remote: 'https://spot.utilitarian.io',
    local: ''
  };
  const VALID_PRESETS = new Set(['remote', 'local', 'custom']);
  const DEFAULT_PRESET = 'remote';
  const ORIGIN_STORAGE_KEY = 'spot.dev.originPreset';
  const ORIGIN_CUSTOM_KEY = 'spot.dev.originCustom';

  const normalizeOrigin = value => {
    if (typeof value !== 'string') return '';
    let input = value.trim();
    if (!input) return '';
    if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
    try {
      return new URL(input).origin;
    } catch (_) {
      return '';
    }
  };

  const loadPreset = () => {
    try {
      const stored = localStorage.getItem(ORIGIN_STORAGE_KEY);
      return stored && VALID_PRESETS.has(stored) ? stored : DEFAULT_PRESET;
    } catch (_) {
      return DEFAULT_PRESET;
    }
  };

  const savePreset = preset => {
    if (!VALID_PRESETS.has(preset)) return;
    try { localStorage.setItem(ORIGIN_STORAGE_KEY, preset); } catch (_) {}
  };

  const loadCustomOrigin = () => {
    try { return normalizeOrigin(localStorage.getItem(ORIGIN_CUSTOM_KEY) || ''); } catch (_) { return ''; }
  };

  const saveCustomOrigin = value => {
    const normalized = normalizeOrigin(value);
    try {
      if (normalized) {
        localStorage.setItem(ORIGIN_CUSTOM_KEY, normalized);
      } else {
        localStorage.removeItem(ORIGIN_CUSTOM_KEY);
      }
    } catch (_) {}
    return normalized;
  };

  /* ------------------------------------------------------------------------ */
  /* Harness state                                                            */
  /* ------------------------------------------------------------------------ */

  const state = {
    zone: null,
    lastTimestamp: null,
    origin: ORIGIN_PRESETS.remote,
    originPreset: DEFAULT_PRESET
  };

  let swReadyPromise = null;
  let controllerPromise = null;

  /* ------------------------------------------------------------------------ */
  /* View helpers                                                             */
  /* ------------------------------------------------------------------------ */

  const setStatus = message => {
    if (statusEl) statusEl.textContent = message || '';
  };

  const formatTimestamp = value => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('en-GB', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }) + ' UTC';
  };

  const describeOrigin = origin => {
    if (!origin) return `Local files (${location.origin})`;
    if (origin === ORIGIN_PRESETS.remote) return `Remote (${origin})`;
    return `Custom (${origin})`;
  };

  const updateDisplay = () => {
    if (zoneEl) zoneEl.textContent = state.zone || '—';
    if (tsEl) tsEl.textContent = formatTimestamp(state.lastTimestamp);
    if (originEl) originEl.textContent = describeOrigin(state.origin);

    if (originSelect && originSelect.value !== state.originPreset) {
      originSelect.value = state.originPreset;
    }

    if (customOriginWrap) {
      customOriginWrap.classList.toggle('hidden', state.originPreset !== 'custom');
    }

    if (customOriginInput) {
      customOriginInput.disabled = state.originPreset !== 'custom';
      if (state.originPreset === 'custom') {
        customOriginInput.value = state.origin || '';
      } else {
        customOriginInput.value = '';
      }
    }
  };

  /* ------------------------------------------------------------------------ */
  /* Service worker helpers                                                   */
  /* ------------------------------------------------------------------------ */

  const ensureServiceWorker = async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers are not supported in this browser.');
    }
    if (!swReadyPromise) {
      swReadyPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(() => navigator.serviceWorker.ready);
    }
    return swReadyPromise;
  };

  const waitForController = () => {
    if (navigator.serviceWorker.controller) return Promise.resolve(navigator.serviceWorker.controller);
    if (!controllerPromise) {
      controllerPromise = new Promise(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', function handler() {
          navigator.serviceWorker.removeEventListener('controllerchange', handler);
          resolve(navigator.serviceWorker.controller);
        });
      });
    }
    return controllerPromise;
  };

  const sendMessage = async message => {
    try {
      await ensureServiceWorker();
      const controller = navigator.serviceWorker.controller || await waitForController();
      controller?.postMessage(message);
    } catch (err) {
      console.warn('Dev harness could not reach service worker', err);
      setStatus('Could not reach service worker.');
    }
  };

  const handleMessage = event => {
    const data = event.data || {};
    switch (data.type) {
      case 'state':
      case 'state-updated':
        if (data.state) {
          state.zone = data.state.zone || null;
          state.lastTimestamp = data.state.lastTimestamp || null;
          updateDisplay();
          setStatus(state.zone ? `Watching ${state.zone}` : 'Choose a zone to enable alerts.');
        }
        break;
      case 'new-prices':
        if (data.timestamp) {
          state.lastTimestamp = data.timestamp;
          updateDisplay();
        }
        break;
      default:
        break;
    }
  };

  /* ------------------------------------------------------------------------ */
  /* Event bindings                                                           */
  /* ------------------------------------------------------------------------ */

  const bindEvents = () => {
    requestButton?.addEventListener('click', async () => {
      if (!('Notification' in window)) {
        setStatus('Notifications are not supported in this browser.');
        return;
      }
      try {
        const permission = await Notification.requestPermission();
        setStatus(`Notification permission: ${permission}`);
      } catch (err) {
        console.warn('Permission request failed', err);
        setStatus('Notification permission request failed.');
      }
    });

    notifyButton?.addEventListener('click', async () => {
      await sendMessage({ type: 'dev-notify' });
      setStatus('Dev notification requested.');
    });

    clearButton?.addEventListener('click', async () => {
      navigator.clearAppBadge?.();
      await sendMessage({ type: 'clear-badge' });
      setStatus('Badge cleared.');
    });

    originSelect?.addEventListener('change', async () => {
      const preset = originSelect.value && VALID_PRESETS.has(originSelect.value)
        ? originSelect.value
        : DEFAULT_PRESET;

      if (preset === 'custom') {
        customOriginWrap?.classList.remove('hidden');
        customOriginInput?.focus();
        return;
      }

      state.originPreset = preset;
      state.origin = ORIGIN_PRESETS[preset];
      savePreset(preset);
      updateDisplay();
      await sendMessage({ type: 'set-data-origin', origin: state.origin, preset });
      setStatus(`Data source set to ${describeOrigin(state.origin)}.`);
    });

    if (customOriginInput) {
      const applyCustomOrigin = async () => {
        const normalized = saveCustomOrigin(customOriginInput.value);
        state.originPreset = 'custom';
        state.origin = normalized;
        savePreset('custom');
        updateDisplay();
        await sendMessage({ type: 'set-data-origin', origin: state.origin, preset: 'custom' });
        setStatus(normalized ? `Data source set to Custom (${normalized}).` : 'Custom origin cleared.');
      };

      customOriginInput.addEventListener('change', applyCustomOrigin);
      customOriginInput.addEventListener('blur', applyCustomOrigin);
      customOriginInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          applyCustomOrigin();
        }
      });
    }
  };

  /* ------------------------------------------------------------------------ */
  /* Initialisation                                                           */
  /* ------------------------------------------------------------------------ */

  const init = async () => {
    bindEvents();

    if (!('serviceWorker' in navigator)) {
      setStatus('Service workers are not available.');
      return;
    }

    navigator.serviceWorker.addEventListener('message', handleMessage);

    const preset = loadPreset();
    state.originPreset = preset;
    state.origin = preset === 'custom' ? loadCustomOrigin() : (ORIGIN_PRESETS[preset] ?? ORIGIN_PRESETS.remote);
    updateDisplay();
    setStatus(`Data source set to ${describeOrigin(state.origin)}.`);

    await ensureServiceWorker();
    await sendMessage({ type: 'set-data-origin', origin: state.origin, preset: state.originPreset });
    await sendMessage({ type: 'request-state' });
  };

  init().catch(err => {
    console.warn('Dev harness initialisation failed', err);
    setStatus('Dev harness failed to initialise.');
  });
})();
