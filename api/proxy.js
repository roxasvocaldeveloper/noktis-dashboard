// ═══════════════════════════════════════════════════════════════
// Songstats proxy — caching a 2 livelli per preservare la quota API
//
//  Layer 1: EDGE CACHE (Vercel CDN, automatico via Cache-Control)
//           → s-maxage controlla quanto la CDN trattiene la risposta
//           → stale-while-revalidate consente di servire risposta
//             vecchia mentre in background si aggiorna
//
//  Layer 2: IN-MEMORY (locale al singolo container serverless)
//           → coalesce richieste burst sulla stessa function instance
//           → utile per traffico ravvicinato (5 min)
//
//  Quota Songstats: limite mensile per artist_id.
//  Con questi TTL → ~4-8 chiamate/giorno per endpoint.
// ═══════════════════════════════════════════════════════════════

const https = require('https');

const SONGSTATS_KEY = process.env.SONGSTATS_API_KEY || '92da5d29-82a1-412c-82b4-770efb2f518f';

// Endpoint → { upstream, edgeTtl (CDN), swr (stale-while-revalidate), memTtl (in-process) }
const ROUTES = {
  // Stats live: cambiano lentamente, 6h edge / 24h SWR / 5min memory
  'songstats':          { upstream: 'artists/stats',          edgeTtl: 21600,  swr: 86400, memTtl: 300 },
  // Historic data: aggiornato una volta al giorno, 12h edge / 48h SWR
  'historic_stats':     { upstream: 'artists/historic_stats', edgeTtl: 43200,  swr: 172800, memTtl: 600 },
  // Activities: più dinamiche, 1h edge / 6h SWR
  'activities':         { upstream: 'artists/activities',     edgeTtl: 3600,   swr: 21600, memTtl: 300 },
  // Playlists correnti: 6h edge / 24h SWR
  'playlists/current':  { upstream: 'artists/top_playlists',  edgeTtl: 21600,  swr: 86400, memTtl: 300 },
  // Playlists lifetime: cambiano raramente, 24h edge / 7gg SWR
  'playlists/all':      { upstream: 'artists/top_playlists',  edgeTtl: 86400,  swr: 604800, memTtl: 600 },
};

// ─── In-memory cache (Layer 2) ──────────────────────────────────
const memCache = new Map();          // key → { body, status, expires }
const inflight = new Map();          // key → Promise (coalesce concurrent fetches)

function memGet(key) {
  const hit = memCache.get(key);
  if (hit && hit.expires > Date.now()) return hit;
  if (hit) memCache.delete(key);
  return null;
}
function memSet(key, value, ttlSec) {
  memCache.set(key, { ...value, expires: Date.now() + ttlSec * 1000 });
  // LRU lite: limita a 100 entries
  if (memCache.size > 100) memCache.delete(memCache.keys().next().value);
}

// ─── Fetch upstream Songstats ───────────────────────────────────
function fetchUpstream(target) {
  return new Promise((resolve, reject) => {
    https.get(target, {
      headers: { apikey: SONGSTATS_KEY, Accept: 'application/json' },
    }, (proxyRes) => {
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => resolve({ body, status: proxyRes.statusCode }));
    }).on('error', reject);
  });
}

// ─── Handler ────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const routeKey = req.url.replace(/^\/api\/proxy\/?/, '').split('?')[0];
  const route = ROUTES[routeKey];

  if (!route) {
    res.status(404).json({ error: 'Unknown route: ' + routeKey });
    return;
  }

  const qs = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
  const cacheKey = routeKey + qs;
  const target = `https://api.songstats.com/enterprise/v1/${route.upstream}${qs}`;

  // ─── Layer 2 check: in-memory ─────────────────────────────────
  const memHit = memGet(cacheKey);
  if (memHit) {
    sendCached(res, memHit, route, 'HIT-MEM');
    return;
  }

  // ─── Coalesce: se c'è già una fetch in corso per questa key, aspettala
  if (inflight.has(cacheKey)) {
    try {
      const result = await inflight.get(cacheKey);
      sendCached(res, result, route, 'HIT-INFLIGHT');
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
    return;
  }

  // ─── Fetch upstream ───────────────────────────────────────────
  const promise = fetchUpstream(target);
  inflight.set(cacheKey, promise);

  try {
    const result = await promise;
    // Salva in memoria solo se status OK
    if (result.status >= 200 && result.status < 300) {
      memSet(cacheKey, result, route.memTtl);
    }
    sendCached(res, result, route, 'MISS');
  } catch (err) {
    res.status(502).json({ error: err.message });
  } finally {
    inflight.delete(cacheKey);
  }
};

// ─── Risposta con headers di cache ──────────────────────────────
function sendCached(res, result, route, status) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Vercel edge cache: serve risposta cached per s-maxage secondi.
  // Dopo, serve risposta stale e in background fetch fresca.
  res.setHeader('Cache-Control', `public, s-maxage=${route.edgeTtl}, stale-while-revalidate=${route.swr}`);
  // Debug header per monitorare hit rate
  res.setHeader('X-Cache', status);
  res.status(result.status).send(result.body);
}
