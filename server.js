// Simple proxy server for Songstats API (avoids CORS from browser)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const SONGSTATS_KEY = '92da5d29-82a1-412c-82b4-770efb2f518f';

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Proxy endpoints ────────────────────────────────────────────
  // Route any /api/songstats/* to the corresponding Songstats endpoint
  const PROXY_ROUTES = {
    '/api/songstats':           'artists/stats',
    '/api/playlists/current':   'artists/top_playlists',
    '/api/playlists/all':       'artists/top_playlists',
    '/api/activities':          'artists/activities',
    '/api/historic_stats':      'artists/historic_stats',
    '/api/audience':            'artists/audience',
  };

  if (PROXY_ROUTES[url.pathname]) {
    const qs = url.search;
    const target = `https://api.songstats.com/enterprise/v1/${PROXY_ROUTES[url.pathname]}${qs}`;

    const options = {
      method: 'GET',
      headers: { apikey: SONGSTATS_KEY, Accept: 'application/json' },
    };

    const proxyReq = https.get(target, options, (proxyRes) => {
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(body);
      });
    });
    proxyReq.on('error', err => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── Static file server ─────────────────────────────────────────
  let filePath = path.join(__dirname, url.pathname === '/' ? '/dashboard.html' : url.pathname);
  // Security: stay within __dirname
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));
