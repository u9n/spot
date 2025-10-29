(function () {
  /**
   * Notification + subscription UI controller.
   *
   * Responsibilities:
   *   • keep the flyout menu in sync with the stored country/zone
   *   • manage the Web Push subscription lifecycle (subscribe / unsubscribe)
   *   • talk to the service worker so the last-seen timestamp + zone stay current
   *   • surface clear status text so debugging the flow on devices is easier
   */

  const panel = document.getElementById('spot-notification-panel');
  if (!panel) return;

  /* ------------------------------------------------------------------------ */
  /* DOM references                                                           */
  /* ------------------------------------------------------------------------ */

  const ui = {
    zoneDisplay: document.getElementById('spot-zone-display'),
    status: document.getElementById('spot-notify-status'),
    last: document.getElementById('spot-notify-last'),
    countryBadge: document.getElementById('spot-country-display'),
    settingsPanel: document.getElementById('spot-settings-panel'),
    settingsMenu: document.getElementById('spot-settings-menu'),
    settingsBackdrop: document.getElementById('spot-settings-backdrop'),
    settingsOpeners: [
      document.getElementById('spot-settings-button-desktop'),
      document.getElementById('spot-settings-button-mobile')
    ].filter(Boolean),
    settingsCloser: document.getElementById('spot-settings-close'),
    settingsCountry: document.getElementById('spot-settings-country'),
    settingsZone: document.getElementById('spot-settings-zone'),
    settingsToggle: document.getElementById('spot-notify-toggle'),
    settingsNote: document.getElementById('spot-settings-note'),
    settingsTimezone: document.getElementById('spot-settings-timezone')
  };

  const isAlpineManaged = element => Boolean(element && element.dataset && element.dataset.alpineManaged === 'true');

  /* ------------------------------------------------------------------------ */
  /* Configuration + persisted defaults                                       */
  /* ------------------------------------------------------------------------ */

  const CONFIG = {
    VAPID_PUBLIC_KEY: 'BKgE31SLxw9vhapcaU9usyw09u7SSsixDTzK91jh7paDTcrC3vSvxtXuc10l96jRlYnv2C3naMugDcrmli29oHU',
    SUBSCRIPTION_ENDPOINT: 'https://spot-subscribe.utilitarian.io'
  };

  const STORAGE_KEYS = {
    country: 'spot.settings.country',
    zone: 'spot.settings.zone',
    subscriptionId: 'spot.push.id',
    timezone: 'spot.settings.timezone'
  };

  const LEGACY_KEYS = {
    country: 'spot.country',
    zone: 'spot.zone',
    timezone: 'spot.timezone'
  };

  const COUNTRIES = [
    { code: 'SE', name: 'Sweden', zones: ['SE1', 'SE2', 'SE3', 'SE4'] },
    { code: 'DK', name: 'Denmark', zones: ['DK1', 'DK2'] },
    { code: 'NO', name: 'Norway', zones: ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'] },
    { code: 'FI', name: 'Finland', zones: ['FI'] },
    { code: 'DE', name: 'Germany', zones: ['DE_LU'] },
    { code: 'AT', name: 'Austria', zones: ['AT'] },
    { code: 'FR', name: 'France', zones: ['FR'] },
    { code: 'BE', name: 'Belgium', zones: ['BE'] },
    { code: 'NL', name: 'Netherlands', zones: ['NL'] },
    { code: 'PL', name: 'Poland', zones: ['PL'] },
    { code: 'EE', name: 'Estonia', zones: ['EE'] },
    { code: 'LT', name: 'Lithuania', zones: ['LT'] },
    { code: 'LV', name: 'Latvia', zones: ['LV'] },
    { code: 'IT', name: 'Italy', zones: ['IT-NORTH', 'IT-CENTRE_NORTH', 'IT-CENTRE_SOUTH', 'IT-SOUTH', 'IT-SICILY', 'IT-SARDINIA', 'IT-CALABRIA'] },
    { code: 'CH', name: 'Switzerland', zones: ['CH'] },
    { code: 'ES', name: 'Spain', zones: ['ES'] },
    { code: 'PT', name: 'Portugal', zones: ['PT'] },
    { code: 'SK', name: 'Slovakia', zones: ['SK'] },
    { code: 'SI', name: 'Slovenia', zones: ['SI'] },
    { code: 'CZ', name: 'Czech Republic', zones: ['CZ'] },
    { code: 'HU', name: 'Hungary', zones: ['HU'] },
    { code: 'HR', name: 'Croatia', zones: ['HR'] },
    { code: 'RO', name: 'Romania', zones: ['RO'] },
    { code: 'RS', name: 'Serbia', zones: ['RS'] },
    { code: 'BG', name: 'Bulgaria', zones: ['BG'] },
    { code: 'GR', name: 'Greece', zones: ['GR'] }
  ];
  window.SPOT_COUNTRIES = COUNTRIES;

  /* ------------------------------------------------------------------------ */
  /* Mutable state                                                            */
  /* ------------------------------------------------------------------------ */

  const state = {
    country: null,
    zone: null,
    lastTimestamp: null,
    subscribed: false,
    subscription: null,
    subscriptionId: null,
    settingsOpen: false,
    permission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
    origin: '',          // data origin for fetching index.json
    originPreset: 'remote',
    swReadyPromise: null,
    controllerPromise: null,
    toggleGuard: false,  // used to avoid infinite loops when updating the checkbox programmatically
    timezone: null
  };

  window.addEventListener('spot-settings-opened', () => {
    state.settingsOpen = true;
  });
  window.addEventListener('spot-settings-closed', () => {
    state.settingsOpen = false;
  });

  /* ------------------------------------------------------------------------ */
  /* Utilities                                                                */
  /* ------------------------------------------------------------------------ */

  const NGROK_PATTERN = /(?:\.ngrok(?:-free)?\.app|\.ngrok\.io)$/i;

  const findCountry = code => COUNTRIES.find(c => c.code === code) || null;

  const formatZoneDisplay = () => {
    const country = findCountry(state.country);
    if (!country) return 'Choose a zone';
    if (!state.zone) return `${country.name} – select a zone`;
    return `${state.zone} · ${country.name}`;
  };

  const formatCountryDisplay = () => {
    const country = findCountry(state.country);
    if (!country) return 'Choose a country';
    return `${country.name} (${country.code})`;
  };

  const formatTimestamp = ts => {
    if (!ts) return '';
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return `Last seen: ${ts}`;
    const formatted = date.toLocaleString('en-GB', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    return `Last seen: ${formatted} UTC`;
  };

  const setStatus = message => {
    if (ui.status) ui.status.textContent = message || '';
  };

  const setNote = message => {
    if (!ui.settingsNote) return;
    if (message) {
      ui.settingsNote.textContent = message;
      ui.settingsNote.classList.remove('hidden');
    } else {
      ui.settingsNote.textContent = '';
      ui.settingsNote.classList.add('hidden');
    }
  };

  const updateDisplays = () => {
    if (ui.zoneDisplay && !ui.zoneDisplay.hasAttribute('x-text')) {
      ui.zoneDisplay.textContent = formatZoneDisplay();
    }
    if (ui.countryBadge && !ui.countryBadge.hasAttribute('x-text')) {
      ui.countryBadge.textContent = formatCountryDisplay();
    }
    if (ui.settingsCountry && !isAlpineManaged(ui.settingsCountry)) {
      ui.settingsCountry.value = state.country || '';
    }
    updateZoneSelectOptions();
    if (ui.settingsZone && !isAlpineManaged(ui.settingsZone)) {
      ui.settingsZone.value = state.zone || '';
    }
    if (ui.settingsTimezone && !isAlpineManaged(ui.settingsTimezone) && state.timezone) {
      ui.settingsTimezone.value = state.timezone;
    }
    if (ui.last) ui.last.textContent = formatTimestamp(state.lastTimestamp);
    if (ui.settingsToggle && !state.toggleGuard) {
      ui.settingsToggle.checked = state.subscribed;
    }
  };

  const normalizeZone = zone => {
    if (!zone || typeof zone !== 'string') return null;
    const upper = zone.toUpperCase();
    return /^[A-Z0-9_-]{2,12}$/.test(upper) ? upper : null;
  };

  const urlBase64ToUint8Array = base64String => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  };

  const sha256 = async input => {
    if (!window.crypto || !window.crypto.subtle) return null;
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const shouldBypassNgrokWarning = origin => {
    if (!origin) return false;
    try {
      const { hostname } = new URL(origin);
      return NGROK_PATTERN.test(hostname);
    } catch (_) {
      return false;
    }
  };

  const getDataOrigin = () => {
    if (typeof state.origin === 'string') return state.origin;
    return '';
  };

  const fetchLatestTimestamp = async zone => {
    const base = getDataOrigin() || window.location.origin;
    const url = new URL(`/electricity/${encodeURIComponent(zone)}/latest/index.json`, base);
    const bypassNgrok = shouldBypassNgrokWarning(base);
    if (bypassNgrok) {
      url.searchParams.set('ngrok-skip-browser-warning', 'true');
    }
    const init = {
      cache: 'no-store',
      mode: base ? 'cors' : 'same-origin',
      credentials: 'omit'
    };
    if (bypassNgrok) {
      init.headers = { 'ngrok-skip-browser-warning': 'true' };
    }

    const response = await fetch(url.toString(), init);
    if (!response.ok) {
      throw new Error(`Failed to fetch latest data (${response.status})`);
    }
    const payload = await response.json();
    let latest = null;
    for (const record of payload) {
      const ts = record && record.timestamp;
      if (typeof ts === 'string' && (!latest || ts > latest)) {
        latest = ts;
      }
    }
    return latest;
  };

  /* ------------------------------------------------------------------------ */
  /* Service worker helpers                                                   */
  /* ------------------------------------------------------------------------ */

  const ensureServiceWorker = async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers are not supported in this browser.');
    }
    if (!state.swReadyPromise) {
      state.swReadyPromise = navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then(() => navigator.serviceWorker.ready);
    }
    return state.swReadyPromise;
  };

  const waitForController = () => {
    if (navigator.serviceWorker.controller) {
      return Promise.resolve(navigator.serviceWorker.controller);
    }
    if (!state.controllerPromise) {
      state.controllerPromise = new Promise(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', function handler() {
          navigator.serviceWorker.removeEventListener('controllerchange', handler);
          resolve(navigator.serviceWorker.controller);
        });
      });
    }
    return state.controllerPromise;
  };

  const postToWorker = async message => {
    try {
      await ensureServiceWorker();
      const controller = navigator.serviceWorker.controller || await waitForController();
      if (controller) {
        controller.postMessage(message);
      }
    } catch (error) {
      console.warn('spot-notify: message to SW failed', error);
    }
  };

  const syncStateFromWorker = swState => {
    if (!swState || typeof swState !== 'object') return;
    const zone = normalizeZone(swState.zone);
    const timestamp = typeof swState.lastTimestamp === 'string' ? swState.lastTimestamp : null;
    const origin = typeof swState.origin === 'string' ? swState.origin : '';
    const originPreset = typeof swState.originPreset === 'string' ? swState.originPreset : state.originPreset;

    let changed = false;
    if (zone && zone !== state.zone) {
      state.zone = zone;
      maybePersistZone(zone);
      changed = true;
      const hostingCountry = COUNTRIES.find(c => c.zones.includes(zone));
      if (hostingCountry && hostingCountry.code !== state.country) {
        state.country = hostingCountry.code;
        persistCountry(state.country);
      }
    }
    state.lastTimestamp = timestamp;
    state.origin = origin;
    state.originPreset = originPreset;
    updateDisplays();
    if (changed) {
      dispatchSelectionChange('worker');
    }
  };

  /* ------------------------------------------------------------------------ */
  /* Local storage helpers                                                    */
  /* ------------------------------------------------------------------------ */

  const loadStoredCountry = () => {
    try {
      let stored = localStorage.getItem(STORAGE_KEYS.country);
      if (!stored) {
        stored = localStorage.getItem(LEGACY_KEYS.country);
      }
      return findCountry(stored) ? stored : null;
    } catch (_) {
      return null;
    }
  };

  const persistCountry = value => {
    try {
      if (value) {
        localStorage.setItem(STORAGE_KEYS.country, value);
        localStorage.removeItem(LEGACY_KEYS.country);
      } else {
        localStorage.removeItem(STORAGE_KEYS.country);
        localStorage.removeItem(LEGACY_KEYS.country);
      }
    } catch (_) {
      // ignore storage failures (private browsing)
    }
  };

  const loadStoredZone = country => {
    try {
      let stored = localStorage.getItem(STORAGE_KEYS.zone);
      if (!stored) {
        stored = localStorage.getItem(LEGACY_KEYS.zone);
      }
      if (!stored) return null;
      const upper = normalizeZone(stored);
      const countryInfo = findCountry(country);
      const zones = countryInfo && Array.isArray(countryInfo.zones) ? countryInfo.zones : null;
      const inCountry = zones ? zones.includes(upper) : false;
      return inCountry ? upper : null;
    } catch (_) {
      return null;
    }
  };

  const maybePersistZone = zone => {
    try {
      if (zone) {
        localStorage.setItem(STORAGE_KEYS.zone, zone);
        localStorage.removeItem(LEGACY_KEYS.zone);
      } else {
        localStorage.removeItem(STORAGE_KEYS.zone);
        localStorage.removeItem(LEGACY_KEYS.zone);
      }
    } catch (_) {
      // ignore
    }
  };

  const loadStoredTimezone = () => {
    try {
      let stored = localStorage.getItem(STORAGE_KEYS.timezone);
      if (!stored) {
        stored = localStorage.getItem(LEGACY_KEYS.timezone);
      }
      if (stored) return stored;
    } catch (_) {
      // ignore
    }
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (_) {
      return 'UTC';
    }
  };

  const persistTimezone = tz => {
    try {
      if (tz) {
        localStorage.setItem(STORAGE_KEYS.timezone, tz);
        localStorage.removeItem(LEGACY_KEYS.timezone);
      } else {
        localStorage.removeItem(STORAGE_KEYS.timezone);
        localStorage.removeItem(LEGACY_KEYS.timezone);
      }
    } catch (_) {
      // ignore
    }
  };

  const persistSubscriptionId = id => {
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEYS.subscriptionId, id);
      } else {
        localStorage.removeItem(STORAGE_KEYS.subscriptionId);
      }
    } catch (_) {
      // ignore
    }
  };

  /* ------------------------------------------------------------------------ */
  /* UI plumbing                                                               */
  /* ------------------------------------------------------------------------ */

  const fallbackOpenSettings = () => {
    if (!ui.settingsPanel || !ui.settingsMenu || !ui.settingsBackdrop) return;
    ui.settingsPanel.style.display = 'block';
    requestAnimationFrame(() => {
      ui.settingsBackdrop.style.opacity = '1';
      ui.settingsMenu.style.transform = 'translateX(0)';
    });
    window.dispatchEvent(new CustomEvent('spot-settings-opened'));
    setTimeout(() => {
      if (ui.settingsMenu && typeof ui.settingsMenu.focus === 'function') {
        ui.settingsMenu.focus();
      }
    }, 10);
  };

  const fallbackCloseSettings = () => {
    if (!ui.settingsPanel || !ui.settingsMenu || !ui.settingsBackdrop) return;
    ui.settingsBackdrop.style.opacity = '0';
    ui.settingsMenu.style.transform = 'translateX(100%)';
    window.dispatchEvent(new CustomEvent('spot-settings-closed'));
    setTimeout(() => {
      ui.settingsPanel.style.display = 'none';
    }, 250);
  };

  const openSettings = () => {
    state.settingsOpen = true;
    const api = window.spotSettingsPanel;
    if (api && typeof api.open === 'function') {
      api.open();
    } else {
      fallbackOpenSettings();
    }
  };

  const closeSettings = () => {
    state.settingsOpen = false;
    const api = window.spotSettingsPanel;
    if (api && typeof api.close === 'function') {
      api.close();
    } else {
      fallbackCloseSettings();
    }
  };

  const updateZoneSelectOptions = () => {
    if (!ui.settingsZone || isAlpineManaged(ui.settingsZone)) return;
    const country = findCountry(state.country);
    const zones = country && Array.isArray(country.zones) ? country.zones : [];
    ui.settingsZone.innerHTML = '';
    for (const zone of zones) {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = zone;
      ui.settingsZone.appendChild(option);
    }
    if (!zones.includes(state.zone)) {
      state.zone = zones[0] || null;
      maybePersistZone(state.zone);
    }
  };

  const populateCountrySelect = () => {
    if (!ui.settingsCountry || isAlpineManaged(ui.settingsCountry)) return;
    ui.settingsCountry.innerHTML = '<option value="">Choose a country</option>';
    COUNTRIES.forEach(({ code, name }) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${name} (${code})`;
      ui.settingsCountry.appendChild(option);
    });
  };

  const dispatchSelectionChange = reason => {
    const detail = {
      country: state.country,
      zone: state.zone,
      timezone: state.timezone,
      reason: reason || null,
      source: 'spot-notify'
    };
    document.dispatchEvent(new CustomEvent('spot:selection-change', { detail }));
  };

  const dispatchTimezoneChange = reason => {
    document.dispatchEvent(new CustomEvent('spot:timezone-change', {
      detail: { timezone: state.timezone, reason: reason || null, source: 'spot-notify' }
    }));
  };

  const applyCountry = code => {
    const country = findCountry(code) ? code : null;
    state.country = country;
    persistCountry(country);
    updateZoneSelectOptions();
    updateDisplays();
    dispatchSelectionChange('country');
  };

  const applyZone = zone => {
    const normalized = normalizeZone(zone);
    const info = findCountry(state.country);
    const countryZones = info && Array.isArray(info.zones) ? info.zones : [];
    if (!normalized || !countryZones.includes(normalized)) {
      state.zone = countryZones[0] || null;
    } else {
      state.zone = normalized;
    }
    maybePersistZone(state.zone);
    updateDisplays();
    dispatchSelectionChange('zone');
    postToWorker({ type: 'set-zone', zone: state.zone, lastTimestamp: state.lastTimestamp || null });
  };

  let timezoneOptions = [];

  const populateTimezoneSelect = () => {
    if (!ui.settingsTimezone || isAlpineManaged(ui.settingsTimezone)) return;
    if (timezoneOptions.length === 0) {
      if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
        timezoneOptions = Intl.supportedValuesOf('timeZone');
      } else {
        timezoneOptions = [
        'UTC', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Helsinki', 'Europe/Berlin',
        'Europe/Paris', 'Europe/Brussels', 'Europe/Vienna', 'Europe/Rome', 'Europe/Madrid', 'Europe/Lisbon',
        'Europe/Warsaw', 'Europe/Prague', 'Europe/Budapest', 'Europe/Zagreb', 'Europe/Bucharest',
        'Europe/Sofia', 'Europe/Athens', 'Atlantic/Reykjavik', 'America/New_York', 'America/Los_Angeles'
      ];
    }
    ui.settingsTimezone.innerHTML = '';
    timezoneOptions.forEach(zone => {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = zone.replace(/_/g, ' ');
      ui.settingsTimezone.appendChild(option);
    });
  };

  const applyTimezone = tz => {
    if (!tz || typeof tz !== 'string') return;
    if (timezoneOptions.length && !timezoneOptions.includes(tz)) return;
    if (tz === state.timezone) {
      if (ui.settingsTimezone && ui.settingsTimezone.value !== tz) {
        ui.settingsTimezone.value = tz;
      }
      return;
    }
    state.timezone = tz;
    persistTimezone(tz);
    if (ui.settingsTimezone && ui.settingsTimezone.value !== tz) {
      ui.settingsTimezone.value = tz;
    }
    dispatchSelectionChange('timezone');
    dispatchTimezoneChange('timezone');
  };

  /* ------------------------------------------------------------------------ */
  /* Push subscription lifecycle                                              */
  /* ------------------------------------------------------------------------ */

  const ensurePermission = async () => {
    if (!('Notification' in window)) {
      throw new Error('Notifications are not supported in this browser.');
    }
    let { permission } = Notification;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    state.permission = permission;
    if (permission !== 'granted') {
      throw new Error(`Notification permission is ${permission}`);
    }
  };

  const getPushSubscription = async () => {
    const registration = await ensureServiceWorker();
    return await registration.pushManager.getSubscription();
  };

  const subscribePush = async zone => {
    await ensurePermission();
    const registration = await ensureServiceWorker();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const appServerKey = urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey
      });
    }
    const payload = { subscription: subscription.toJSON(), zone };
    const response = await fetch(`${CONFIG.SUBSCRIPTION_ENDPOINT}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`Subscription API responded ${response.status}`);
    }
    const data = await response.json().catch(() => ({}));
    state.subscription = subscription;
    state.subscribed = true;
    state.subscriptionId = typeof data.id === 'string' ? data.id : null;
    persistSubscriptionId(state.subscriptionId);
    return subscription;
  };

  const unsubscribePush = async () => {
    const registration = await ensureServiceWorker();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      state.subscription = null;
      state.subscribed = false;
      state.subscriptionId = null;
      persistSubscriptionId(null);
      return;
    }

    const endpointHash = await sha256(subscription.endpoint);
    try {
      if (endpointHash) {
        await fetch(`${CONFIG.SUBSCRIPTION_ENDPOINT}/subscribe/${endpointHash}`, {
          method: 'DELETE'
        });
      }
    } catch (error) {
      console.warn('spot-notify: failed to unregister subscription in worker', error);
    }

    try {
      await subscription.unsubscribe();
    } catch (error) {
      console.warn('spot-notify: unsubscribe failed', error);
    }
    state.subscription = null;
    state.subscribed = false;
    state.subscriptionId = null;
    persistSubscriptionId(null);
  };

  const enableAlerts = async () => {
    if (!state.zone) {
      setStatus('Choose a bidding zone to enable notifications.');
      state.toggleGuard = true;
      if (ui.settingsToggle) ui.settingsToggle.checked = false;
      state.toggleGuard = false;
      return;
    }
    setStatus('Enabling notifications…');
    try {
      await subscribePush(state.zone);
      const latest = await fetchLatestTimestamp(state.zone).catch(error => {
        console.warn('spot-notify: latest fetch failed', error);
        return null;
      });
      if (latest) {
        state.lastTimestamp = latest;
        await postToWorker({ type: 'set-zone', zone: state.zone, lastTimestamp: latest });
      } else {
        await postToWorker({ type: 'set-zone', zone: state.zone });
      }
      await postToWorker({ type: 'request-state' });
      if (navigator.clearAppBadge) {
        navigator.clearAppBadge();
      }
      state.subscribed = true;
      state.toggleGuard = true;
      if (ui.settingsToggle) ui.settingsToggle.checked = true;
      state.toggleGuard = false;
      setStatus(`Notifications enabled for ${state.zone}.`);
    } catch (error) {
      console.warn('spot-notify: enabling notifications failed', error);
      setStatus(error.message || 'Failed to enable notifications.');
      state.toggleGuard = true;
      if (ui.settingsToggle) ui.settingsToggle.checked = false;
      state.toggleGuard = false;
      state.subscribed = false;
    }
    updateDisplays();
  };

  const disableAlerts = async () => {
    setStatus('Disabling notifications…');
    try {
      await unsubscribePush();
      await postToWorker({ type: 'clear-badge' });
      if (navigator.clearAppBadge) {
        navigator.clearAppBadge();
      }
      setStatus('Notifications disabled.');
    } catch (error) {
      console.warn('spot-notify: disabling notifications failed', error);
      setStatus('Failed to disable notifications completely.');
    }
    state.toggleGuard = true;
    if (ui.settingsToggle) ui.settingsToggle.checked = false;
    state.toggleGuard = false;
    state.subscribed = false;
  };

  const syncSubscriptionState = async () => {
    try {
      const subscription = await getPushSubscription();
      state.subscription = subscription;
      state.subscribed = !!subscription;
      if (!subscription) {
        state.subscriptionId = null;
      }
    } catch (error) {
      console.warn('spot-notify: sync subscription failed', error);
      state.subscription = null;
      state.subscribed = false;
    }
    state.toggleGuard = true;
    if (ui.settingsToggle) ui.settingsToggle.checked = state.subscribed;
    state.toggleGuard = false;
  };

  /* ------------------------------------------------------------------------ */
  /* Event bindings                                                           */
  /* ------------------------------------------------------------------------ */

  const bindEvents = () => {
    ui.settingsOpeners.forEach(btn => btn.addEventListener('click', openSettings));
    if (ui.zoneDisplay) ui.zoneDisplay.addEventListener('click', openSettings);
    if (ui.countryBadge) ui.countryBadge.addEventListener('click', openSettings);
    if (ui.settingsBackdrop) ui.settingsBackdrop.addEventListener('click', closeSettings);
    if (ui.settingsCloser) ui.settingsCloser.addEventListener('click', closeSettings);

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && state.settingsOpen) {
        closeSettings();
      }
    });

    if (ui.settingsCountry) {
      ui.settingsCountry.addEventListener('change', () => {
        applyCountry(ui.settingsCountry.value || null);
        if (ui.settingsZone) {
          applyZone(ui.settingsZone.value || null);
        } else {
          applyZone(null);
        }
      });
    }

    if (ui.settingsZone) {
      ui.settingsZone.addEventListener('change', () => {
        applyZone(ui.settingsZone.value || null);
        if (state.subscribed && state.subscription) {
          // Re-associate the existing subscription with the new zone.
          fetch(`${CONFIG.SUBSCRIPTION_ENDPOINT}/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: state.subscription.toJSON(), zone: state.zone })
          }).catch(error => console.warn('spot-notify: failed to update subscription zone', error));
        }
      });
    }

    if (ui.settingsTimezone) {
      ui.settingsTimezone.addEventListener('change', () => {
        const nextTz = ui.settingsTimezone.value;
        if (nextTz && nextTz !== state.timezone) {
          applyTimezone(nextTz);
        }
      });
    }

    if (ui.settingsToggle) {
      ui.settingsToggle.addEventListener('change', () => {
        if (state.toggleGuard) return;
        if (ui.settingsToggle.checked) {
          enableAlerts();
        } else {
          disableAlerts();
        }
      });
    }

    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', event => {
        const data = event.data || {};
        switch (data.type) {
          case 'state':
          case 'state-updated':
            syncStateFromWorker(data.state);
            break;
          case 'new-prices':
            if (data.timestamp) {
              state.lastTimestamp = data.timestamp;
              updateDisplays();
            }
            if (navigator.clearAppBadge) {
              navigator.clearAppBadge();
            }
            break;
          case 'subscription-change':
            syncSubscriptionState();
            break;
          default:
            break;
        }
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.clearAppBadge) {
        navigator.clearAppBadge();
      }
    });

    document.addEventListener('spot:selection-change', event => {
      const detail = event.detail || {};
      if (detail.source === 'spot-notify') return;
      if (typeof detail.country === 'string' && detail.country !== state.country) {
        applyCountry(detail.country);
      }
      if (typeof detail.zone === 'string' && detail.zone !== state.zone) {
        applyZone(detail.zone);
      }
    });

    document.addEventListener('spot:timezone-change', event => {
      const detail = event.detail || {};
      if (detail.source === 'spot-notify') return;
      if (typeof detail.timezone === 'string' && detail.timezone !== state.timezone) {
        applyTimezone(detail.timezone);
      }
    });
  };

  /* ------------------------------------------------------------------------ */
  /* Initialisation                                                           */
  /* ------------------------------------------------------------------------ */

  const inferDefaultCountry = () => {
    const stored = loadStoredCountry();
    if (stored) return stored;
    const locale = (navigator.language || navigator.userLanguage || '').toUpperCase();
    const match = COUNTRIES.find(c => locale.includes(c.code));
    return match ? match.code : 'SE';
  };

  const bootstrap = async () => {
    populateCountrySelect();
    populateTimezoneSelect();
    setNote(null);
    const defaultCountry = inferDefaultCountry();
    state.country = defaultCountry;
    const storedZone = loadStoredZone(defaultCountry);
    const defaultInfo = findCountry(defaultCountry);
    const defaultZones = defaultInfo && Array.isArray(defaultInfo.zones) ? defaultInfo.zones : [];
    state.zone = storedZone || defaultZones[0] || null;
    maybePersistZone(state.zone);
    const defaultTimezone = loadStoredTimezone();
    if (timezoneOptions.length && !timezoneOptions.includes(defaultTimezone)) {
      state.timezone = 'UTC';
    } else {
      state.timezone = defaultTimezone || 'UTC';
    }
    persistTimezone(state.timezone);
    updateDisplays();
    dispatchSelectionChange('init');
    dispatchTimezoneChange('init');

    bindEvents();

    if (!('serviceWorker' in navigator)) {
      setStatus('Service workers are not available in this browser.');
      setNote('Notifications require a browser with Service Worker and Push API support.');
      if (ui.settingsToggle) ui.settingsToggle.setAttribute('disabled', 'true');
      return;
    }

    await ensureServiceWorker().catch(error => {
      console.warn('spot-notify: SW registration failed', error);
      setStatus('Service worker registration failed.');
    });

    if (!window.isSecureContext && location.protocol !== 'https:') {
      setNote('Notifications require HTTPS or localhost. Open the site over https://spot.utilitarian.io to test push.');
      if (ui.settingsToggle) ui.settingsToggle.setAttribute('disabled', 'true');
      return;
    }
    if (!('PushManager' in window)) {
      setNote('Push notifications are not supported in this browser.');
      if (ui.settingsToggle) ui.settingsToggle.setAttribute('disabled', 'true');
      return;
    }

    await postToWorker({ type: 'request-state' });
    await syncSubscriptionState();

    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      setNote('Notifications are blocked for this origin. Re-enable them in the browser settings to subscribe.');
    }

    if (state.subscribed) {
      setStatus(`Notifications enabled for ${state.zone || 'your zone'}.`);
    } else {
      setStatus('Toggle notifications in the settings menu to receive alerts.');
    }
    updateDisplays();
  };

  bootstrap().catch(error => {
    console.warn('spot-notify: bootstrap failed', error);
    setStatus('Notification setup failed to initialise.');
  });
}
})();
