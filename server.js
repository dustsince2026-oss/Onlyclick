'use strict';
// Servidor local para probar OnlyClick sin desplegar.
// Uso: npm install (opcional, solo para Supabase) && npm run dev
// Abre http://localhost:3000
// En local usa data/db.json + data/uploads/ (no compartido, solo pruebas).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { dispatch } = require('./api/_lib/handlers');
const { tokenFromReq } = require('./api/_lib/auth');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const ROUTES = {
  'auth-register': 'register', 'auth-login': 'login', 'auth-status': 'auth-status',
  'password-forgot': 'password-forgot', 'password-reset': 'password-reset',
  'events': 'list-events', 'event-create': 'create-event', 'event-get': 'get-event',
  'photo-upload': 'upload-photo', 'search': 'search', 'claim': 'claim', 'purchase': 'purchase',
  'my-photos': 'my-photos', 'sales': 'sales', 'set-free-mode': 'set-free-mode',
  'set-tip': 'set-tip', 'event-delete': 'delete-event', 'event-cover': 'upload-cover', 'photo-update': 'update-photo', 'photo-delete': 'delete-photo', 'read-bib': 'read-bib',
  'checkout-create': 'checkout-create', 'checkout-status': 'checkout-status', 'clip-webhook': 'clip-webhook', 'set-event-price': 'set-event-price',
  // NOTA: la ruta simulada 'purchase' se eliminó a propósito: con Clip
  // real, cualquiera podría llamar /api/purchase y descargar sin pagar.
  // El cobro real es POST /api/checkout-create.
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 12 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const query = Object.fromEntries(url.searchParams.entries());

    if (url.pathname === '/api/photo') {
      const result = await dispatch('photo-file', { body: {}, query, token: tokenFromReq({ ...req, query, headers: req.headers }) });
      res.writeHead(200, {
        'Content-Type': result.file.mimeType,
        'Content-Disposition': result.file.inline ? 'inline' : `attachment; filename="${result.file.filename}"`,
        'Content-Length': result.file.bytes.length,
        // Los bytes de una foto nunca cambian para un mismo id: caché larga.
        'Cache-Control': 'public, max-age=86400, immutable',
      });
      return res.end(result.file.bytes);
    }

    if (url.pathname === '/api/cover') {
      const result = await dispatch('cover-file', { body: {}, query, token: tokenFromReq({ ...req, query, headers: req.headers }) });
      res.writeHead(200, {
        'Content-Type': result.file.mimeType,
        'Content-Disposition': 'inline',
        'Content-Length': result.file.bytes.length,
      });
      return res.end(result.file.bytes);
    }

    // Regreso desde Clip tras el pago: verifica con Clip y redirige al
    // corredor a la foto (no devuelve JSON: el navegador viene de Clip).
    if (url.pathname === '/api/checkout-return') {
      const result = await dispatch('checkout-return', { body: {}, query, token: tokenFromReq({ ...req, query, headers: req.headers }) });
      if (result.redirect) { res.writeHead(302, { Location: result.redirect }); return res.end(); }
      res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result.data));
    }

    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/\/$/, '');
      const route = ROUTES[name];
      if (!route) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Ruta no encontrada.' })); }
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await dispatch(route, { body, query, token: tokenFromReq({ ...req, body, query, headers: req.headers }) });
      res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result.data));
    }

    // Archivos estáticos
    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    file = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || 'Error del servidor.' }));
  }
});

server.listen(PORT, () => console.log(`OnlyClick local en http://localhost:${PORT}`));
