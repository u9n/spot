// ------------------------------------------------------------
// Service worker
//
// Responsibilities:
//   • persist the last selected zone + timestamp in KV-like caches
//   • perform foreground (fallback) polls when asked
//   • display notifications when Web Push payloads arrive
//   • relay messages between the SW and any open clients
//
// The worker does *not* schedule Periodic Background Sync anymore – Web Push is
// the primary notification mechanism.  We keep the fallback poll logic so that
// the dev harness and browsers without push support (e.g. iOS) still receive
// updates whenever they bring the page back into focus.
// ------------------------------------------------------------

const STATE_CACHE = 'spot-state-v1';
const STATE_URL = '/__spot/state';
const PERIOD_MS = 15 * 60 * 1000; // 15 minutes
const JITTER_MS = 5 * 60 * 1000; // up to 5 minutes jitter
const ICON_URL = new URL('/assets/favicon/notification-icon.png', self.location.origin).href;
const BADGE_URL = new URL('/assets/favicon/notification-badge.png', self.location.origin).href;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const REMOTE_DATA_ORIGIN = 'https://spot.utilitarian.io';
const DEFAULT_DATA_ORIGIN = self.location && LOCAL_HOSTS.has(self.location.hostname) ? REMOTE_DATA_ORIGIN : '';
const DEFAULT_ORIGIN_PRESET = DEFAULT_DATA_ORIGIN ? (DEFAULT_DATA_ORIGIN === REMOTE_DATA_ORIGIN ? 'remote' : 'custom') : 'local';
const VALID_ORIGIN_PRESETS = new Set(['remote', 'local', 'custom']);
let dataOrigin = DEFAULT_DATA_ORIGIN;
let originPreset = DEFAULT_ORIGIN_PRESET;
const NGROK_HOST_PATTERN = /(?:\.ngrok(?:-free)?\.app|\.ngrok\.io)$/i;

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

async function openStateCache() {
  return await caches.open(STATE_CACHE);
}

async function postToClients(message) {
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientsList) {
    client.postMessage(message);
  }
}

function sanitizeOriginValue(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    return url.origin;
  } catch (_) {
    return '';
  }
}

function resolvePresetForOrigin(origin, requestedPreset) {
  if (requestedPreset && VALID_ORIGIN_PRESETS.has(requestedPreset)) {
    if (requestedPreset === 'local') {
      return 'local';
    }
    if (requestedPreset === 'remote') {
      return origin === REMOTE_DATA_ORIGIN ? 'remote' : (origin ? 'custom' : 'local');
    }
    if (requestedPreset === 'custom') {
      return 'custom';
    }
  }
  if (!origin) {
    return 'local';
  }
  if (origin === REMOTE_DATA_ORIGIN) {
    return 'remote';
  }
  return 'custom';
}

function shouldBypassNgrokWarning(origin) {
  if (typeof origin !== 'string' || !origin) {
    return false;
  }
  try {
    const hostname = new URL(origin).hostname;
    return NGROK_HOST_PATTERN.test(hostname);
  } catch (_) {
    return false;
  }
}

async function getState() {
  const base = {
    zone: null,
    lastTimestamp: null,
    origin: DEFAULT_DATA_ORIGIN,
    originPreset: DEFAULT_ORIGIN_PRESET
  };
  const cache = await openStateCache();
  const match = await cache.match(STATE_URL);
  if (!match) {
    dataOrigin = base.origin;
    originPreset = base.originPreset;
    return base;
  }
  let stored;
  try {
    stored = await match.json();
  } catch (_) {
    dataOrigin = base.origin;
    originPreset = base.originPreset;
    return base;
  }
  const zone = typeof stored.zone === 'string' && stored.zone ? stored.zone : null;
  const lastTimestamp = typeof stored.lastTimestamp === 'string' ? stored.lastTimestamp : null;
  const rawOrigin = typeof stored.origin === 'string' ? stored.origin : DEFAULT_DATA_ORIGIN;
  const origin = rawOrigin === ''
    ? ''
    : sanitizeOriginValue(rawOrigin) || DEFAULT_DATA_ORIGIN;
  const preset = resolvePresetForOrigin(origin, typeof stored.originPreset === 'string' ? stored.originPreset : null);
  dataOrigin = origin;
  originPreset = preset;
  return { zone, lastTimestamp, origin, originPreset: preset };
}

async function setState(partial) {
  const cache = await openStateCache();
  const current = await getState();

  // The worker stores state as a single JSON blob.  `partial` lets callers
  // update just the properties they care about, so we merge it with the
  // currently cached value before writing it back.
  let originValue = current.origin;
  if (Object.prototype.hasOwnProperty.call(partial, 'origin')) {
    const incoming = partial.origin;
    if (typeof incoming === 'string') {
      originValue = incoming === '' ? '' : (sanitizeOriginValue(incoming) || originValue);
    } else if (incoming === null) {
      originValue = '';
    }
  }

  let presetInput = Object.prototype.hasOwnProperty.call(partial, 'originPreset') ? partial.originPreset : current.originPreset;
  let resolvedPreset = resolvePresetForOrigin(originValue, presetInput);
  if (resolvedPreset === 'local') {
    originValue = '';
  } else if (resolvedPreset === 'remote') {
    originValue = REMOTE_DATA_ORIGIN;
  }
  resolvedPreset = resolvePresetForOrigin(originValue, resolvedPreset);

  const next = {
    zone: Object.prototype.hasOwnProperty.call(partial, 'zone')
      ? (typeof partial.zone === 'string' && partial.zone ? partial.zone : null)
      : current.zone,
    lastTimestamp: Object.prototype.hasOwnProperty.call(partial, 'lastTimestamp')
      ? (typeof partial.lastTimestamp === 'string' ? partial.lastTimestamp : null)
      : current.lastTimestamp,
    origin: originValue,
    originPreset: resolvedPreset
  };

  dataOrigin = next.origin;
  originPreset = next.originPreset;

  await cache.put(STATE_URL, new Response(JSON.stringify(next), {
    headers: { 'Content-Type': 'application/json' }
  }));
  return next;
}

function computeJitter() {
  return Math.floor(Math.random() * JITTER_MS);
}

async function fetchLatest(zone) {
  const origin = typeof dataOrigin === 'string' ? dataOrigin : DEFAULT_DATA_ORIGIN;
  const base = origin || self.location.origin;
  const url = new URL(`/electricity/${encodeURIComponent(zone)}/latest/index.json`, base);
  const bypassNgrok = shouldBypassNgrokWarning(origin);
  if (bypassNgrok) {
    url.searchParams.set('ngrok-skip-browser-warning', 'true');
  }
  const init = {
    cache: 'no-store',
    mode: origin ? 'cors' : 'same-origin',
    credentials: 'omit'
  };
  if (bypassNgrok) {
    init.headers = {
      'ngrok-skip-browser-warning': 'true'
    };
  }
  const response = await fetch(url.toString(), init);
  if (!response.ok) {
    throw new Error(`Failed to fetch latest for ${zone}`);
  }
  const data = await response.json();
  let latestTimestamp = null;
  for (const entry of data) {
    const ts = entry && entry.timestamp;
    if (ts && (!latestTimestamp || ts > latestTimestamp)) {
      latestTimestamp = ts;
    }
  }
  return latestTimestamp;
}

async function announce(zone, timestamp) {
  if (typeof timestamp === 'string' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      await self.registration.showNotification(`New day-ahead prices for ${zone}!`, {
        body: 'Tap to view the latest values.',
        icon: ICON_URL,
        badge: BADGE_URL,
        data: { url: `/explorer/?zones=${encodeURIComponent(zone)}`, zone, timestamp }
      });
    } catch (err) {
      console.warn('Notification failed', err);
    }
  }

  if (self.registration.setAppBadge) {
    try {
      await self.registration.setAppBadge(1);
    } catch (_) {
      // ignore if unsupported
    }
  }

  await postToClients({ type: 'new-prices', zone, timestamp });
}

async function handleSync({ skipDelay = false } = {}) {
  const state = await getState();
  if (!state.zone) {
    return;
  }

  if (!skipDelay) {
    const jitter = computeJitter();
    if (jitter > 0) {
      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }

  try {
    const latestTimestamp = await fetchLatest(state.zone);
    if (!latestTimestamp) {
      return;
    }
    const previousTimestamp = state.lastTimestamp || null;
    if (!previousTimestamp) {
      const updated = await setState({ zone: state.zone, lastTimestamp: latestTimestamp });
      await postToClients({ type: 'state-updated', state: updated });
      return;
    }
    if (latestTimestamp > previousTimestamp) {
      const updated = await setState({ zone: state.zone, lastTimestamp: latestTimestamp });
      await announce(state.zone, latestTimestamp);
      await postToClients({ type: 'state-updated', state: updated });
    }
  } catch (err) {
    console.warn('Price polling failed', err);
  }
}

async function handlePushEvent(event) {
  let payload = {};
  let rawPayload = null;
  if (event.data) {
    try {
      rawPayload = await event.data.text();
    } catch (_) {
      rawPayload = null;
    }
  }

  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch (_) {
      payload = { title: rawPayload };
    }
  }

  const zone = typeof payload.zone === 'string' ? payload.zone.toUpperCase() : null;
  const timestamp = typeof payload.timestamp === 'string' ? payload.timestamp : null;
  const title = payload.title || (zone ? `New day-ahead prices for ${zone}!` : 'New day-ahead prices available!');
  const body = payload.body || 'Tap to view the latest values.';
  const targetUrl = payload.url || (zone ? `/explorer/?zones=${encodeURIComponent(zone)}` : '/explorer/');

  const options = {
    body,
    icon: payload.icon || ICON_URL,
    badge: payload.badge || BADGE_URL,
    data: { url: targetUrl, zone, timestamp },
    tag: payload.tag || (zone ? `spot-zone-${zone}` : 'spot-prices'),
    renotify: payload.renotify ?? true,
    requireInteraction: payload.requireInteraction ?? false,
    color: payload.color || '#0f172a'
  };

  if (payload.image) {
    options.image = payload.image;
  }
  if (timestamp) {
    const tsMs = Date.parse(timestamp);
    if (!Number.isNaN(tsMs)) {
      options.timestamp = tsMs;
    }
  }

  if (zone && timestamp) {
    try {
      const state = await getState();
      if (state.zone === zone) {
        const updated = await setState({ zone, lastTimestamp: timestamp });
        await postToClients({ type: 'state-updated', state: updated });
      }
    } catch (err) {
      console.warn('Failed to persist push timestamp', err);
    }
  }

  await self.registration.showNotification(title, options);
  if (self.registration.setAppBadge) {
    self.registration.setAppBadge(1).catch(() => {});
  }
  await postToClients({ type: 'new-prices', zone, timestamp });
}

self.addEventListener('push', event => {
  event.waitUntil(handlePushEvent(event));
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(postToClients({ type: 'subscription-change' }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    if (self.registration.clearAppBadge) {
      try {
        await self.registration.clearAppBadge();
      } catch (_) {}
    }
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        await client.focus();
        if (event.notification.data && event.notification.data.zone) {
          client.postMessage({ type: 'focus-zone', zone: event.notification.data.zone });
        }
        return;
      }
    }
    const url = (event.notification.data && event.notification.data.url) || '/explorer/';
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  switch (data.type) {
    case 'set-zone':
      event.waitUntil((async () => {
        const current = await getState();
        const zone = typeof data.zone === 'string' && data.zone ? data.zone : null;
        const newLast = typeof data.lastTimestamp === 'string'
          ? data.lastTimestamp
          : (zone && current.zone === zone ? current.lastTimestamp : null);
        const state = {
          zone,
          lastTimestamp: newLast,
          origin: current.origin,
          originPreset: current.originPreset
        };
        const updated = await setState(state);
        if (!zone && self.registration.clearAppBadge) {
          self.registration.clearAppBadge().catch(() => {});
        }
        await postToClients({ type: 'state-updated', state: updated });
      })());
      break;
    case 'trigger-poll':
      event.waitUntil(handleSync({ skipDelay: !!data.skipDelay }));
      break;
    case 'request-state':
      event.waitUntil((async () => {
        const state = await getState();
        if (event.source) {
          event.source.postMessage({ type: 'state', state });
        }
      })());
      break;
    case 'clear-badge':
      if (self.registration.clearAppBadge) {
        self.registration.clearAppBadge().catch(() => {});
      }
      break;
    case 'set-data-origin':
      event.waitUntil((async () => {
        const current = await getState();
        const originInput = typeof data.origin === 'string' ? data.origin : current.origin;
        const presetInput = typeof data.preset === 'string' ? data.preset : current.originPreset;
        const updated = await setState({
          zone: current.zone,
          lastTimestamp: current.lastTimestamp,
          origin: originInput,
          originPreset: presetInput
        });
        await postToClients({ type: 'state-updated', state: updated });
      })());
      break;
    case 'dev-notify':
      event.waitUntil((async () => {
        const state = await getState();
        const zone = state.zone || 'DEV';
        const now = new Date().toISOString();
        try {
          await self.registration.showNotification(`Dev notification for ${zone}`, {
            body: 'Triggered from the local harness.',
            icon: ICON_URL,
            badge: BADGE_URL,
            data: { url: `/explorer/?zones=${encodeURIComponent(zone)}`, zone, timestamp: now }
          });
        } catch (err) {
          console.warn('Dev notification failed', err);
        }
        if (self.registration.setAppBadge) {
          self.registration.setAppBadge(1).catch(() => {});
        }
      })());
      break;
    default:
      break;
  }
});
