'use strict';
// Servidor local para probar OnlyClick sin desplegar.
// Uso: npm install (opcional, solo para Supabase) && npm run dev
// Abre http://localhost:3000
// En local usa data/db.json + data/uploads/ (no compartido, solo pruebas).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { dispatch, ogMetaForRef } = require('./api/_lib/handlers');
const { tokenFromReq } = require('./api/_lib/auth');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const ROUTES = {
  'auth-register': 'register', 'auth-login': 'login', 'auth-status': 'auth-status',
  'password-forgot': 'password-forgot', 'password-reset': 'password-reset',
  'events': 'list-events', 'event-create': 'create-event', 'event-get': 'get-event',
  'photo-upload': 'upload-photo', 'backfill-thumbs': 'backfill-thumbs', 'subscribe-photo-alert': 'subscribe-photo-alert', 'photo-meta': 'photo-meta', 'shared-cart': 'shared-cart', 'search': 'search', 'claim': 'claim', 'purchase': 'purchase',
  'my-photos': 'my-photos', 'remove-download': 'remove-download', 'sales': 'sales', 'set-free-mode': 'set-free-mode', 'set-event-hidden': 'set-event-hidden', 'set-event-upcoming': 'set-event-upcoming',
  'set-tip': 'set-tip', 'event-delete': 'delete-event', 'event-cover': 'upload-cover', 'photo-update': 'update-photo', 'photo-delete': 'delete-photo', 'read-bib': 'read-bib',
  'face-search': 'face-search',
  'face-search-instant': 'face-search-instant', 'index-photo-faces': 'index-photo-faces',
  'checkout-create': 'checkout-create', 'checkout-create-cart': 'checkout-create-cart', 'checkout-status': 'checkout-status', 'clip-webhook': 'clip-webhook', 'set-event-price': 'set-event-price',
  'validate-discount-code': 'validate-discount-code', 'create-discount-code': 'create-discount-code', 'generate-discount-codes': 'generate-discount-codes', 'list-discount-codes': 'list-discount-codes', 'deactivate-discount-code': 'deactivate-discount-code',
  'track-view': 'track-view', 'stats': 'stats',
  'approve-photographer': 'approve-photographer', 'list-photographers': 'list-photographers',
  'submit-application': 'submit-application', 'list-applications': 'list-applications',
  'review-application': 'review-application', 'invite-status': 'invite-status',
  'create-announcement': 'create-announcement', 'list-announcements': 'list-announcements',
  'mark-announcements-read': 'mark-announcements-read',
  // Recompensas (2026-11-20): referidos + primeros 100 atletas.
  'rewards': 'rewards', 'rewards-check': 'rewards-check', 'referral-info': 'referral-info',
  'set-payout-clabe': 'set-payout-clabe', 'payouts-summary': 'payouts-summary',
  'payouts-mark-paid': 'payouts-mark-paid', 'payouts-history': 'payouts-history',
  'my-earnings': 'my-earnings',
  'join-event': 'join-event', 'leave-event': 'leave-event',
  'event-participants': 'event-participants',
  'set-display-name': 'set-display-name', 'set-my-event-price': 'set-my-event-price',
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

function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Reemplaza las etiquetas Open Graph por defecto por las del referido
// (og:title, og:description, og:url; la imagen es la misma siempre).
// Si alguna etiqueta no está en el HTML, se deja como está (no rompe).
function injectOg(html, og) {
  let out = String(html);
  out = out.replace(/(<meta property="og:title" content=")[^"]*(")/, (m, p1, p2) => p1 + escAttr(og.title) + p2);
  out = out.replace(/(<meta property="og:description" content=")[^"]*(")/, (m, p1, p2) => p1 + escAttr(og.description) + p2);
  out = out.replace(/(<meta property="og:url" content=")[^"]*(")/, (m, p1, p2) => p1 + escAttr(og.url) + p2);
  return out;
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
        // Caché del edge (Vercel): `s-maxage` es lo que lee la CDN;
        // `max-age` solo lo lee el navegador. Solo se cachea cuando los
        // bytes NO dependen de quién pide (lo decide photoFile en
        // handlers.js: miniatura siempre, completa solo en evento gratis).
        // La vista previa y la descarga de un evento de pago llevan
        // `no-store`: la misma URL da miniatura u original según quién
        // pide, y guardarla en el edge filtraría el original o serviría
        // la miniatura a quien compró. ESTE es el servidor que corre en
        // vivo en Vercel (server.js es el entrypoint); api/photo.js es
        // solo el equivalente local y NO se ejecuta en producción.
        'Cache-Control': result.file.cacheable ? 'public, max-age=86400, s-maxage=86400, immutable' : 'private, max-age=0, no-store',
      });
      return res.end(result.file.bytes);
    }

    if (url.pathname === '/api/cover') {
      const result = await dispatch('cover-file', { body: {}, query, token: tokenFromReq({ ...req, query, headers: req.headers }) });
      res.writeHead(200, {
        'Content-Type': result.file.mimeType,
        'Content-Disposition': 'inline',
        'Content-Length': result.file.bytes.length,
        // Portada: igual para todos los que ven el evento (el álbum
        // oculto exige token en la URL, así que su clave de caché es
        // solo del dueño). Sin `immutable`: la portada sí se puede
        // cambiar; el navegador revalida cada hora y el edge la guarda
        // un día. (Igual que arriba: en vivo corre este server.js, no
        // api/cover.js.)
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
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
    // Vista previa Open Graph con ?ref= (2026-11-20): Facebook arma la
    // vista previa del link con las etiquetas de la página. Solo se
    // inyecta cuando viene ?ref=; sin ref, la página se sirve igual que
    // siempre. El parámetro &compartir= (primeros100 o referidos) dice
    // QUÉ tarjeta se compartió y cambia la vista previa (ver
    // ogMetaForRef); sin él, la vista previa es la de siempre. Sin
    // caché agresiva: cada link de referido tiene sus propias etiquetas
    // y Facebook debe leer las nuevas. Si algo falla, cae al envío
    // normal de abajo (la página nunca se rompe).
    if (path.basename(file) === 'index.html' && query.ref) {
      try {
        const og = await ogMetaForRef(query.ref, undefined, query.compartir);
        const html = injectOg(fs.readFileSync(file, 'utf8'), og);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=0, no-cache' });
        return res.end(html);
      } catch (_) { /* envío normal */ }
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || 'Error del servidor.' }));
  }
});

server.listen(PORT, () => console.log(`OnlyClick local en http://localhost:${PORT}`));
