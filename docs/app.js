(() => {
  // ---------------------------------------------------------------------------
  // Shared service worker helpers
  // ---------------------------------------------------------------------------

  let swReadyPromise = null;
  let controllerPromise = null;

  const ensureServiceWorker = async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers are not supported in this browser.');
    }
    if (!swReadyPromise) {
      swReadyPromise = navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
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
        navigator.serviceWorker.addEventListener('controllerchange', function handler() {
          navigator.serviceWorker.removeEventListener('controllerchange', handler);
          resolve(navigator.serviceWorker.controller);
        });
      });
    }
    return controllerPromise;
  };

  const postMessageToSW = async message => {
    await ensureServiceWorker();
    const controller = navigator.serviceWorker.controller || await waitForController();
    if (!controller) {
      throw new Error('Service worker controller not ready.');
    }
    controller.postMessage(message);
  };

  const addServiceWorkerListener = handler => {
    if (!('serviceWorker' in navigator)) return () => {};
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  };

  // ---------------------------------------------------------------------------
  // Dev Notification Harness
  // ---------------------------------------------------------------------------
  // Optional panel that exposes manual controls for testing push behaviour.
  // ---------------------------------------------------------------------------

  const initDevHarness = () => {
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

  const sendMessage = async message => {
    try {
      await postMessageToSW(message);
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

    addServiceWorkerListener(handleMessage);

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
  };

  // ---------------------------------------------------------------------------
  // Notification controller (push subscription + UI bridge)
  // ---------------------------------------------------------------------------

  const initNotifications = () => {
    const toggleEl = document.getElementById('spot-notify-toggle');
    const zoneSelectEl = document.getElementById('spot-notify-zone');
    const noteEl = document.getElementById('spot-settings-note');
    if (!toggleEl || !zoneSelectEl) return;

    toggleEl.setAttribute('disabled', 'true');

    const CONFIG = {
      VAPID_PUBLIC_KEY: 'BKgE31SLxw9vhapcaU9usyw09u7SSsixDTzK91jh7paDTcrC3vSvxtXuc10l96jRlYnv2C3naMugDcrmli29oHU'
    };

    const STORAGE_KEYS = {
      enabled: 'spot.notifications.enabled',
      subscriptionId: 'spot.push.id',
      endpointOverride: 'spot.dev.subscriptionEndpoint'
    };

    const state = {
      zone: (window.SPOT_STORAGE && window.SPOT_STORAGE.notificationZone) || zoneSelectEl.value || null,
      enabled: false,
      dataOrigin: '',
      subscription: null,
      processing: false
    };

    let suppressToggleEvent = false;

    const readStoredEnabled = () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEYS.enabled);
        if (stored === null) return window.SPOT_STORAGE ? !!window.SPOT_STORAGE.notificationEnabled : false;
        return stored === 'true';
      } catch (_) {
        return false;
      }
    };

    const persistEnabled = value => {
      try {
        localStorage.setItem(STORAGE_KEYS.enabled, value ? 'true' : 'false');
      } catch (_) {
        // ignore storage issues
      }
    };

    const persistSubscriptionId = value => {
      try {
        if (value) {
          localStorage.setItem(STORAGE_KEYS.subscriptionId, value);
        } else {
          localStorage.removeItem(STORAGE_KEYS.subscriptionId);
        }
      } catch (_) {
        // ignore
      }
    };

    const normalizeEndpointOrigin = endpoint => {
      if (typeof endpoint !== 'string') return null;
      let candidate = endpoint.trim();
      if (!candidate) return null;
      try {
        if (!/^https?:\/\//i.test(candidate)) {
          candidate = `https://${candidate}`;
        }
        const url = new URL(candidate);
        return url.origin;
      } catch (_) {
        return null;
      }
    };

    const resolveSubscriptionEndpoint = () => {
      if (typeof window !== 'undefined' && window.SPOT_SUBSCRIPTION_ENDPOINT) {
        const manual = normalizeEndpointOrigin(window.SPOT_SUBSCRIPTION_ENDPOINT);
        if (manual) {
          localStorage.setItem(STORAGE_KEYS.endpointOverride, manual);
          return manual;
        }
      }

      try {
        const search = new URLSearchParams(location.search);
        const param = search.get('subscription-endpoint') || search.get('push-endpoint');
        const fromQuery = normalizeEndpointOrigin(param);
        if (fromQuery) {
          localStorage.setItem(STORAGE_KEYS.endpointOverride, fromQuery);
          return fromQuery;
        }
      } catch (_) {
        // ignore URL parsing failures
      }

      try {
        const stored = localStorage.getItem(STORAGE_KEYS.endpointOverride);
        const normalized = normalizeEndpointOrigin(stored);
        if (normalized) return normalized;
      } catch (_) {
        // ignore
      }

      if (typeof document !== 'undefined') {
        const meta = document.querySelector('meta[name="spot:subscription-endpoint"]');
        if (meta && typeof meta.content === 'string') {
          const normalizedMeta = normalizeEndpointOrigin(meta.content);
          if (normalizedMeta) return normalizedMeta;
        }
      }

      if (typeof location !== 'undefined' && location.hostname.endsWith('.workers.dev')) {
        return `${location.protocol}//${location.host}`;
      }

      return 'https://subscribe.spot.utilitarian.io';
    };

    const SUBSCRIPTION_ENDPOINT = resolveSubscriptionEndpoint();

    const setNote = message => {
      if (!noteEl) return;
      if (message) {
        noteEl.textContent = message;
        noteEl.classList.remove('hidden');
      } else {
        noteEl.textContent = '';
        noteEl.classList.add('hidden');
      }
    };

    const setToggleChecked = value => {
      suppressToggleEvent = true;
      toggleEl.checked = value;
      suppressToggleEvent = false;
      document.dispatchEvent(new CustomEvent('spot:notification-toggle-state', {
        detail: { enabled: value, source: 'notifications', reason: 'sync' }
      }));
    };

    const disableToggle = message => {
      toggleEl.setAttribute('disabled', 'true');
      setNote(message);
    };

    const sha256 = async input => {
      if (!window.crypto || !window.crypto.subtle) return null;
      const bytes = new TextEncoder().encode(input);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    };

    const getSubscription = async registration => {
      return registration.pushManager.getSubscription();
    };

    const ensurePermission = async () => {
      if (!('Notification' in window)) {
        throw new Error('Notifications are not supported in this browser.');
      }
      let { permission } = Notification;
      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }
      if (permission !== 'granted') {
        throw new Error(`Notification permission is ${permission}.`);
      }
    };

    const subscribePush = async zone => {
      await ensurePermission();
      const registration = await ensureServiceWorker();
      let subscription = await getSubscription(registration);
      if (!subscription) {
        const appServerKey = (() => {
          const padding = '='.repeat((4 - (CONFIG.VAPID_PUBLIC_KEY.length % 4)) % 4);
          const base64 = (CONFIG.VAPID_PUBLIC_KEY + padding).replace(/-/g, '+').replace(/_/g, '/');
          const rawData = window.atob(base64);
          const outputArray = new Uint8Array(rawData.length);
          for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
          }
          return outputArray;
        })();
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey
        });
      }
      await fetch(`${SUBSCRIPTION_ENDPOINT}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          zone
        })
      }).then(async response => {
        if (!response.ok) {
          throw new Error(`Subscription API responded ${response.status}`);
        }
        const data = await response.json().catch(() => ({}));
        if (data && data.id) {
          persistSubscriptionId(data.id);
        } else {
          persistSubscriptionId(null);
        }
      });
      return subscription;
    };

    const unsubscribePush = async () => {
      const registration = await ensureServiceWorker();
      const subscription = await getSubscription(registration);
      if (!subscription) {
        persistSubscriptionId(null);
        return;
      }

      const storedId = (() => {
        try {
          return localStorage.getItem(STORAGE_KEYS.subscriptionId);
        } catch (_) {
          return null;
        }
      })();

      const endpointHash = storedId || await sha256(subscription.endpoint);
      if (endpointHash) {
        try {
          await fetch(`${SUBSCRIPTION_ENDPOINT}/subscribe/${endpointHash}`, {
            method: 'DELETE'
          });
        } catch (error) {
          console.warn('notifications: failed to remove subscription from backend', error);
        }
      }

      try {
        await subscription.unsubscribe();
      } catch (error) {
        console.warn('notifications: unsubscribe() failed', error);
      }
      persistSubscriptionId(null);
    };

    const fetchLatestTimestamp = async zone => {
      if (!zone) return null;
      const origin = state.dataOrigin || '';
      const base = origin || window.location.origin;
      const url = new URL(`/electricity/${encodeURIComponent(zone)}/latest/index.json`, base);
      const init = {
        cache: 'no-store',
        mode: origin ? 'cors' : 'same-origin',
        credentials: 'omit'
      };
      if (origin && /ngrok/.test(origin)) {
        url.searchParams.set('ngrok-skip-browser-warning', 'true');
        init.headers = { 'ngrok-skip-browser-warning': 'true' };
      }
      const response = await fetch(url, init);
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null);
      if (!Array.isArray(payload)) return null;
      let latest = null;
      for (const record of payload) {
        if (record && typeof record.timestamp === 'string') {
          if (!latest || record.timestamp > latest) {
            latest = record.timestamp;
          }
        }
      }
      return latest;
    };

    const updateWorkerZone = async ({ zone, lastTimestamp }) => {
      await postMessageToSW({ type: 'set-zone', zone: zone || null, lastTimestamp: lastTimestamp || null });
      await postMessageToSW({ type: 'request-state' });
    };

    const setEnabled = async desired => {
      if (state.processing) return;
      if (desired === state.enabled) return;
      if (!state.zone && desired) {
        setNote('Choose a bidding zone to enable notifications.');
        setToggleChecked(false);
        persistEnabled(false);
        state.enabled = false;
        return;
      }

      state.processing = true;
      if (desired) {
        setNote('Enabling notifications…');
        try {
          state.subscription = await subscribePush(state.zone);
          let latest = null;
          try {
            latest = await fetchLatestTimestamp(state.zone);
          } catch (fetchError) {
            console.warn('notifications: latest timestamp fetch failed', fetchError);
          }
          await updateWorkerZone({ zone: state.zone, lastTimestamp: latest });
          navigator.clearAppBadge?.();
          state.enabled = true;
          persistEnabled(true);
          setToggleChecked(true);
          setNote(`Notifications enabled for ${state.zone}.`);
        } catch (error) {
          console.warn('notifications: enabling failed', error);
          state.subscription = null;
          state.enabled = false;
          persistEnabled(false);
          setToggleChecked(false);
          if (error && /denied/i.test(String(error))) {
            setNote('Notifications are blocked for this browser. Please allow notifications to subscribe.');
          } else if (error && /granted/i.test(Notification.permission || '')) {
            setNote(error.message || 'Failed to enable notifications.');
          } else if (Notification.permission === 'denied') {
            setNote('Notifications are blocked for this site. Re-enable them in the browser settings to subscribe.');
          } else {
            setNote(error.message || 'Failed to enable notifications.');
          }
        }
      } else {
        setNote('Disabling notifications…');
        try {
          await unsubscribePush();
          await postMessageToSW({ type: 'clear-badge' });
          await updateWorkerZone({ zone: null });
          navigator.clearAppBadge?.();
        } catch (error) {
          console.warn('notifications: disabling failed', error);
        }
        state.subscription = null;
        state.enabled = false;
        persistEnabled(false);
        setToggleChecked(false);
        setNote('Notifications disabled.');
      }
      state.processing = false;
    };

    const handleZoneChange = detail => {
      const zones = Array.isArray(detail.zones) ? detail.zones : [];
      const nextZone = typeof detail.primary === 'string' && detail.primary
        ? detail.primary
        : (zones.length ? zones[0] : null);
      if (nextZone && nextZone !== state.zone) {
        state.zone = nextZone;
        if (state.enabled) {
          subscribePush(state.zone)
            .then(sub => {
              state.subscription = sub;
              return updateWorkerZone({ zone: state.zone });
            })
            .catch(error => console.warn('notifications: zone update failed', error));
        } else {
          updateWorkerZone({ zone: state.zone }).catch(() => {});
        }
      } else if (!nextZone && state.zone) {
        state.zone = null;
        if (state.enabled) {
          setEnabled(false);
        } else {
          updateWorkerZone({ zone: null }).catch(() => {});
        }
      }
    };

    const handleToggleRequest = detail => {
      const requested = typeof detail.enabled === 'boolean'
        ? detail.enabled
        : (typeof detail.checked === 'boolean' ? detail.checked : !!detail);
      setEnabled(requested);
    };

    const handleServiceWorkerMessage = event => {
      const data = event.data || {};
      if (data.type === 'state' || data.type === 'state-updated') {
        if (data.state && typeof data.state === 'object') {
          state.dataOrigin = typeof data.state.origin === 'string' ? data.state.origin : state.dataOrigin;
          const zone = typeof data.state.zone === 'string' ? data.state.zone : null;
          if (zone && zone !== state.zone) {
            state.zone = zone;
            document.dispatchEvent(new CustomEvent('spot:notification-zone-change', {
              detail: { zones: [zone], primary: zone, source: 'notifications', reason: 'worker-sync' }
            }));
          }
        }
      }
    };

    const onToggleChange = () => {
      if (suppressToggleEvent) return;
      document.dispatchEvent(new CustomEvent('spot:notification-toggle', {
        detail: { enabled: !!toggleEl.checked, source: 'notifications', reason: 'dom-change' }
      }));
    };

    const onZoneSelectChange = () => {
      const zone = zoneSelectEl.value || null;
      if (state.enabled) {
        setNote('Disable notifications to change the bidding zone.');
        suppressToggleEvent = true;
        zoneSelectEl.value = state.zone || '';
        suppressToggleEvent = false;
        return;
      }
      if (zone && zone !== state.zone) {
        state.zone = zone;
        document.dispatchEvent(new CustomEvent('spot:notification-zone-change', {
          detail: { zones: [zone], primary: zone, source: 'notifications', reason: 'dom-change' }
        }));
      } else if (!zone && state.zone) {
        state.zone = null;
        document.dispatchEvent(new CustomEvent('spot:notification-zone-change', {
          detail: { zones: [], primary: null, source: 'notifications', reason: 'dom-change' }
        }));
      }
    };

    const setInitialState = async () => {
      if (!('serviceWorker' in navigator)) {
        disableToggle('Service workers are not available in this browser.');
        return;
      }

    if (!window.isSecureContext && location.protocol !== 'https:') {
      disableToggle('Notifications require HTTPS or localhost.');
      return;
    }

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isIOS && !isStandalone) {
      disableToggle('Add Spot to your Home Screen to enable notifications on iOS (Share → Add to Home Screen, then reopen).');
      return;
    }

    if (!('PushManager' in window)) {
      disableToggle('Push notifications are not supported in this browser.');
      return;
    }

      toggleEl.removeAttribute('disabled');
      state.enabled = readStoredEnabled();
      setToggleChecked(state.enabled);

      addServiceWorkerListener(handleServiceWorkerMessage);

      let registration = null;
      try {
        registration = await ensureServiceWorker();
      } catch (error) {
        console.warn('notifications: service worker registration threw', error);
        try {
          registration = await navigator.serviceWorker.getRegistration('/sw.js');
        } catch (_) {
          registration = null;
        }
        if (registration) {
          console.info('notifications: using existing service worker registration');
        } else {
          disableToggle('Service worker registration failed.');
          return;
        }
      }

      if (state.enabled) {
        setEnabled(true);
      } else {
        updateWorkerZone({ zone: state.zone }).catch(() => {});
      }
    };

    toggleEl.addEventListener('change', onToggleChange);
    zoneSelectEl.addEventListener('change', onZoneSelectChange);

    document.addEventListener('spot:notification-zone-change', event => {
      if (event.detail && event.detail.source === 'notifications') return;
      handleZoneChange(event.detail || {});
    });

    document.addEventListener('spot:notification-toggle', event => {
      if (event.detail && event.detail.source === 'notifications') return;
      handleToggleRequest(event.detail || {});
    });

    setInitialState();

    window.SPOT_NOTIFY = {
      enable: () => setEnabled(true),
      disable: () => setEnabled(false),
      state
    };
  };

  initDevHarness();
  initNotifications();
})();
