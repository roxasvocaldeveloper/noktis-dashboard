// Local dev proxy for Songstats API (mirrors api/proxy.js production behavior)
// In-memory cache + coalesce, no edge cache (handled by Vercel in prod).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const SONGSTATS_KEY = process.env.SONGSTATS_API_KEY || '92da5d29-82a1-412c-82b4-770efb2f518f';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// Same routing as api/proxy.js
const ROUTES = {
  '/api/songstats':           { upstream: 'artists/stats',          memTtl: 300 },
  '/api/historic_stats':      { upstream: 'artists/historic_stats', memTtl: 600 },
  '/api/activities':          { upstream: 'artists/activities',     memTtl: 300 },
  '/api/playlists/current':   { upstream: 'artists/top_playlists',  memTtl: 300 },
  '/api/playlists/all':       { upstream: 'artists/top_playlists',  memTtl: 600 },
};

// ─── In-memory cache + inflight coalesce ────────────────────────
const memCache = new Map();
const inflight = new Map();

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = ROUTES[url.pathname];

  // ── Proxy endpoint ─────────────────────────────────────────────
  if (route) {
    const qs = url.search;
    const cacheKey = url.pathname + qs;
    const target = `https://api.songstats.com/enterprise/v1/${route.upstream}${qs}`;

    // Memory cache check
    const hit = memCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      console.log(`[CACHE HIT-MEM] ${cacheKey}`);
      writeProxyResponse(res, hit, 'HIT-MEM');
      return;
    }

    // Coalesce
    if (inflight.has(cacheKey)) {
      try {
        const result = await inflight.get(cacheKey);
        writeProxyResponse(res, result, 'HIT-INFLIGHT');
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Fetch + cache
    const promise = fetchUpstream(target);
    inflight.set(cacheKey, promise);
    try {
      const result = await promise;
      if (result.status >= 200 && result.status < 300) {
        memCache.set(cacheKey, { ...result, expires: Date.now() + route.memTtl * 1000 });
        if (memCache.size > 100) memCache.delete(memCache.keys().next().value);
      }
      console.log(`[CACHE MISS] ${cacheKey} → ${result.status}`);
      writeProxyResponse(res, result, 'MISS');
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      inflight.delete(cacheKey);
    }
    return;
  }

  // ── Static file server ─────────────────────────────────────────
  const publicDir = path.join(__dirname, 'public');
  let filePath;
  if (url.pathname === '/') {
    filePath = path.join(publicDir, 'index.html');
  } else {
    const inPublic = path.join(publicDir, url.pathname);
    filePath = fs.existsSync(inPublic) ? inPublic : path.join(__dirname, url.pathname);
  }
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

function writeProxyResponse(res, result, status) {
  res.writeHead(result.status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Cache': status,
  });
  res.end(result.body);
}

server.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));
