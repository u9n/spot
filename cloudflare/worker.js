// Cloudflare Worker: minimal JSON API for storing Web Push subscriptions and
// the latest published timestamp per zone.  The GitHub Action that sends push
// notifications will query the same KV.

const SUB_PREFIX = 'sub';
const MAP_PREFIX = 'map';
const TS_PREFIX = 'ts';

export default {
  async fetch(req, env) {
    const cors = buildCors(req, env);
    if (cors.blocked) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const headers = cors.headers;
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const url = new URL(req.url);

    try {
      if (req.method === 'GET' && url.pathname === '/admin/health') {
        return json(200, { status: 'ok', timestamp: Date.now() }, headers);
      }

      if (req.method === 'POST' && url.pathname === '/subscribe') {
        const body = await safeJson(req);
        const sub = body?.subscription;
        const zone = normalizeZone(body?.zone);

        if (!validSub(sub) || !zone) {
          return json(400, { error: 'invalid_payload' }, headers);
        }

        const id = await sha256(sub.endpoint);

        const oldZone = await env.subscriptions.get(`${MAP_PREFIX}:${id}`);
        if (oldZone && oldZone !== zone) {
          await env.subscriptions.delete(`${SUB_PREFIX}:${oldZone}:${id}`);
        }

        await env.subscriptions.put(`${SUB_PREFIX}:${zone}:${id}`, JSON.stringify(sub));
        await env.subscriptions.put(`${MAP_PREFIX}:${id}`, zone);

        return json(201, { id, zone }, headers);
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/subscribe/')) {
        const id = url.pathname.split('/').pop();
        if (!id) {
          return json(400, { error: 'missing_id' }, headers);
        }
        const zone = await env.subscriptions.get(`${MAP_PREFIX}:${id}`);
        if (zone) {
          await env.subscriptions.delete(`${SUB_PREFIX}:${zone}:${id}`);
          await env.subscriptions.delete(`${MAP_PREFIX}:${id}`);
        }
        return new Response(null, { status: 204, headers });
      }

      if (req.method === 'GET' && url.pathname === '/admin/subs') {
        if (!isAdmin(req, env)) {
          return json(401, { error: 'unauthorized' }, headers);
        }
        const zone = normalizeZone(url.searchParams.get('zone'));
        if (!zone) {
          return json(400, { error: 'invalid_zone' }, headers);
        }
        const list = await env.subscriptions.list({ prefix: `${SUB_PREFIX}:${zone}:` });
        const subs = await Promise.all(list.keys.map(key => env.subscriptions.get(key.name)));
        const payload = subs.filter(Boolean).map(raw => JSON.parse(raw));
        return json(200, payload, headers);
      }

      if (url.pathname.startsWith('/admin/ts/')) {
        if (!isAdmin(req, env)) {
          return json(401, { error: 'unauthorized' }, headers);
        }
        const zone = normalizeZone(url.pathname.split('/').pop());
        if (!zone) {
          return json(400, { error: 'invalid_zone' }, headers);
        }
        if (req.method === 'GET') {
          const ts = await env.subscriptions.get(`${TS_PREFIX}:${zone}`);
          return json(200, { zone, timestamp: ts || null }, headers);
        }
        if (req.method === 'PUT') {
          const body = await safeJson(req);
          const ts = body?.timestamp;
          if (!ts || typeof ts !== 'string') {
            return json(400, { error: 'invalid_timestamp' }, headers);
          }
          await env.subscriptions.put(`${TS_PREFIX}:${zone}`, ts);
          return json(200, { zone, timestamp: ts }, headers);
        }
      }

      return json(404, { error: 'not_found' }, headers);
    } catch (error) {
      return json(500, { error: 'server_error', detail: String(error) }, headers);
    }
  }
};

function buildCors(req, env) {
  const origin = req.headers.get('Origin');
  const configured =
    env.ALLOWED_ORIGINS ||
    env.ALLOWED_ORIGIN ||
    '*';

  const allowed = configured
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  const allowAny = allowed.length === 0 || allowed.includes('*');

  if (!origin) {
    // Requests from service workers / curl (no Origin header) are allowed.
    return {
      blocked: false,
      headers: corsHeaders(allowAny ? '*' : allowed[0] || '*', allowAny)
    };
  }

  if (!allowAny && !allowed.includes(origin)) {
    return { blocked: true };
  }

  return {
    blocked: false,
    headers: corsHeaders(allowAny ? origin : origin, allowAny)
  };
}

function corsHeaders(allowOrigin, allowAny) {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
  if (allowAny) {
    headers.Vary = 'Origin';
  }
  return headers;
}

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

// Fail-safe JSON parsing so malformed payloads don’t explode the worker.
async function safeJson(req) {
  try {
    return await req.json();
  } catch (_) {
    return null;
  }
}


function isAdmin(req, env) {
  const provided = req.headers.get('Authorization') || '';
  const token = env.ADMIN_SECRET;
  if (!token) {
    return false;
  }
  return provided === `Bearer ${token}`;
}

function validSub(sub) {
  return !!sub
    && typeof sub.endpoint === 'string'
    && sub.keys
    && typeof sub.keys.p256dh === 'string'
    && typeof sub.keys.auth === 'string';
}

function normalizeZone(zone) {
  if (!zone || typeof zone !== 'string') return null;
  const upper = zone.toUpperCase();
  return /^[A-Z0-9_-]{2,32}$/.test(upper) ? upper : null;
}

async function sha256(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
