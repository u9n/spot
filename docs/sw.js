const STATE_CACHE = 'spot-state-v1';
const STATE_URL = '/__spot/state';
const PERIOD_MS = 15 * 60 * 1000; // 15 minutes
const JITTER_MS = 5 * 60 * 1000; // up to 5 minutes jitter
const ICON_URL = '/assets/favicon/favicon-96x96.png';
const SYNC_TAG = 'spot-latest-sync';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

async function openStateCache() {
  return await caches.open(STATE_CACHE);
}

async function getState() {
  const cache = await openStateCache();
  const match = await cache.match(STATE_URL);
  if (!match) {
    return { zone: null, lastTimestamp: null };
  }
  try {
    return await match.json();
  } catch (_) {
    return { zone: null, lastTimestamp: null };
  }
}

async function setState(state) {
  const cache = await openStateCache();
  await cache.put(STATE_URL, new Response(JSON.stringify(state), {
    headers: { 'Content-Type': 'application/json' }
  }));
  return state;
}

function computeJitter() {
  return Math.floor(Math.random() * JITTER_MS);
}

async function fetchLatest(zone) {
  const response = await fetch(`/electricity/${zone}/latest/`, { cache: 'no-store' });
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
        badge: ICON_URL,
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

  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientsList) {
    client.postMessage({ type: 'new-prices', zone, timestamp });
  }
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
   if (!state.lastTimestamp || latestTimestamp > state.lastTimestamp) {
     state.lastTimestamp = latestTimestamp;
     await setState(state);
     await announce(state.zone, latestTimestamp);
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientsList) {
        client.postMessage({ type: 'state-updated', state });
      }
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
        const zone = data.zone || null;
        const state = {
          zone,
          lastTimestamp: zone && current.zone === zone ? current.lastTimestamp : null
        };
        const updated = await setState(state);
        if (!zone && self.registration.clearAppBadge) {
          self.registration.clearAppBadge().catch(() => {});
        }
        if (event.source) {
          event.source.postMessage({ type: 'state-updated', state: updated });
        }
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
    default:
      break;
  }
});
