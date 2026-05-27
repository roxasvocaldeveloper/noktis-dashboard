const https = require('https');

const SONGSTATS_KEY = '92da5d29-82a1-412c-82b4-770efb2f518f';

const ROUTE_MAP = {
  'artist_info':        'artists/info',
  'songstats':          'artists/stats',
  'historic_stats':     'artists/historic_stats',
  'playlists/current':  'artists/top_playlists',
  'playlists/all':      'artists/top_playlists',
  'activities':         'artists/activities',
  'audience':           'artists/audience',
  'top_tracks':         'artists/top_tracks',
  'catalog':            'artists/catalog',
  'track_stats':        'tracks/stats',
};

module.exports = async (req, res) => {
  // Extract route key from URL: /api/proxy/track_stats → "track_stats"
  const routeKey = req.url.replace(/^\/api\/proxy\/?/, '').split('?')[0];
  const endpoint = ROUTE_MAP[routeKey];

  if (!endpoint) {
    res.status(404).json({ error: 'Unknown route: ' + routeKey });
    return;
  }

  const qs = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
  const target = `https://api.songstats.com/enterprise/v1/${endpoint}${qs}`;

  return new Promise((resolve) => {
    const proxyReq = https.get(target, {
      headers: { apikey: SONGSTATS_KEY, Accept: 'application/json' },
    }, (proxyRes) => {
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-store');
        res.status(proxyRes.statusCode).send(body);
        resolve();
      });
    });
    proxyReq.on('error', err => {
      res.status(502).json({ error: err.message });
      resolve();
    });
  });
};
