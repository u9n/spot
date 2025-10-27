const STATE_CACHE = 'spot-state-v1';
const STATE_URL = '/__spot/state';
const PERIOD_MS = 15 * 60 * 1000; // 15 minutes
const JITTER_MS = 5 * 60 * 1000; // up to 5 minutes jitter
const ICON_URL = '/assets/favicon/notification-icon.png';
const BADGE_URL = '/assets/favicon/notification-badge.png';
const SYNC_TAG = 'spot-latest-sync';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_DATA_ORIGIN = self.location && LOCAL_HOSTS.has(self.location.hostname) ? 'https://spot.utilitarian.io' : '';
let dataOrigin = DEFAULT_DATA_ORIGIN;

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

async function getState() {
  const base = { zone: null, lastTimestamp: null, origin: DEFAULT_DATA_ORIGIN };
  const cache = await openStateCache();
  const match = await cache.match(STATE_URL);
  if (!match) {
    dataOrigin = base.origin;
    return base;
  }
  let stored;
  try {
    stored = await match.json();
  } catch (_) {
    dataOrigin = base.origin;
    return base;
  }
  const zone = typeof stored.zone === 'string' && stored.zone ? stored.zone : null;
  const lastTimestamp = typeof stored.lastTimestamp === 'string' ? stored.lastTimestamp : null;
  const origin = typeof stored.origin === 'string' ? stored.origin : DEFAULT_DATA_ORIGIN;
  dataOrigin = origin;
  return { zone, lastTimestamp, origin };
}

async function setState(state) {
  const cache = await openStateCache();
  const next = {
    zone: typeof state.zone === 'string' && state.zone ? state.zone : null,
    lastTimestamp: typeof state.lastTimestamp === 'string' ? state.lastTimestamp : null,
    origin: typeof state.origin === 'string' ? state.origin : (dataOrigin ?? DEFAULT_DATA_ORIGIN)
  };
  dataOrigin = next.origin;
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
  const base = origin || '';
  const url = `${base}/electricity/${encodeURIComponent(zone)}/latest/index.json`;
  const response = await fetch(url, { cache: 'no-store' });
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
      state.lastTimestamp = latestTimestamp;
      const updated = await setState(state);
      await postToClients({ type: 'state-updated', state: updated });
      return;
    }
    if (latestTimestamp > previousTimestamp) {
      state.lastTimestamp = latestTimestamp;
      const updated = await setState(state);
      await announce(state.zone, latestTimestamp);
      await postToClients({ type: 'state-updated', state: updated });
    }
  } catch (err) {
    console.warn('Price polling failed', err);
  }
}

self.addEventListener('periodicsync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(handleSync());
  }
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
        const state = {
          zone,
          lastTimestamp: zone && current.zone === zone ? current.lastTimestamp : null,
          origin: current.origin
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
        const origin = typeof data.origin === 'string' ? data.origin : DEFAULT_DATA_ORIGIN;
        const current = await getState();
        const updated = await setState({
          zone: current.zone,
          lastTimestamp: current.lastTimestamp,
          origin
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
