// Pruebas de checkout-status por lote (Orlan, 2026-11-22).
// Al abrir un álbum de pago, el frontend pregunta el estado de las
// fotos con { photoIds: [...] }. Antes el servidor lo resolvía foto por
// foto (2 consultas por foto, una por una: 60 fotos = 120 consultas) y
// abrir el álbum tardaba segundos; el Trijex (gratis) no preguntaba
// nada y abría directo. Ahora son 2 consultas en total, en paralelo.
// Reglas que se cubren (la respuesta es la misma de antes):
// - Por cada foto: pagada si ya la descargó (owned) o su último pago
//   está completado; si no, el estado de su último pago, o 'none'.
// - Gana el ÚLTIMO pago de la foto, no el primero (un pago viejo
//   completado no tapa uno nuevo pendiente).
// - paid global solo si TODAS las fotos pedidas están pagadas.
// No toca la red ni usa credenciales reales.
'use strict';
const path = require('path');
const fs = require('fs');

process.env.AUTH_SECRET = 'test-secret-onlyclick';
process.env.CLIP_API_KEY = 'test-clip-key';
process.env.CLIP_API_SECRET = 'test-clip-secret';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const libDir = path.join(__dirname, '..', 'api', '_lib');
const handlersPath = path.join(libDir, 'handlers.js');
const storePath = path.join(libDir, 'store.js');
const mailerPath = path.join(libDir, 'mailer.js');
const clipPath = path.join(libDir, 'clip.js');

require.cache[clipPath] = { exports: {
  createCheckoutLink: async () => ({ payment_request_id: 'clip-test-1', payment_request_url: 'https://clip.test/pay' }),
  getCheckout: async () => ({ status: 'CHECKOUT_COMPLETED', receipt_no: 'TEST123' }),
} };
require.cache[mailerPath] = { exports: { sendResetEmail: async () => {}, sendSaleEmail: async () => {}, sendEmail: async () => {} } };

// El adaptador local REAL se carga ANTES de instalar el mock del store.
const { fileStore: realFileStore } = require(storePath);
require.cache[storePath] = { exports: { getStore: () => realFileStore } };

const { dispatch } = require(handlersPath);
const { signToken } = require(path.join(libDir, 'auth.js'));

const OWNER = { id: 1, name: 'Ricardo Orlan López Velázquez', email: 'dust.since2026@gmail.com', role: 'photographer', isOwner: true, approved: true, displayName: 'Only Dust' };
const BUYER = { id: 2, name: 'Comprador Prueba', email: 'comprador@test.mx', role: 'athlete', isOwner: false, approved: true, displayName: '' };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ---------------- Siembra del adaptador local real ----------------
// Escribe en <carpeta>/data/db.json; se borra al final.
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
function seedDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function call(route, body, token, query) {
  return dispatch(route, { body: body || {}, query: query || {}, token: token === undefined ? signToken(2) : token });
}

(async () => {
  seedDb({
    users: [OWNER, BUYER],
    events: [
      { id: 5, name: 'Prueba 2', photographerId: 1, freeMode: false, priceMxn: 25, eventDate: '2027-06-01' },
    ],
    photos: [
      { id: 660, eventId: 5, filename: 'f660.jpg', bibs: ['354'], price: 25, photographerId: 1 },
      { id: 661, eventId: 5, filename: 'f661.jpg', bibs: ['355'], price: 25, photographerId: 1 },
      { id: 662, eventId: 5, filename: 'f662.jpg', bibs: ['356'], price: 25, photographerId: 1 },
      { id: 663, eventId: 5, filename: 'f663.jpg', bibs: ['357'], price: 25, photographerId: 1 },
    ],
    // 660: pago viejo completado (id 1) + pago nuevo pendiente (id 3):
    // gana el último. 663: solo pendiente. 661: sin pago, pero con
    // descarga (ya es suya).
    payments: [
      { id: 1, userId: 2, photoId: 660, eventId: 5, amount: 25, status: 'completed', clipPaymentRequestId: 'clip-a', receiptNo: 'R1', createdAt: '2026-11-22T00:00:00.000Z' },
      { id: 2, userId: 2, photoId: 663, eventId: 5, amount: 25, status: 'pending', clipPaymentRequestId: 'clip-b', receiptNo: '', createdAt: '2026-11-22T00:01:00.000Z' },
      { id: 3, userId: 2, photoId: 660, eventId: 5, amount: 25, status: 'pending', clipPaymentRequestId: 'clip-c', receiptNo: '', createdAt: '2026-11-22T00:02:00.000Z' },
    ],
    downloads: [
      { id: 1, userId: 2, photoId: 661, eventId: 5, amount: 25, createdAt: '2026-11-22T00:00:00.000Z' },
    ],
    views: [], payouts: [], announcements: [], discountCodes: [],
    seq: { user: 3, event: 6, photo: 664, download: 2, payment: 4, view: 1, payout: 1, announcement: 1, discountCode: 1 },
  });

  // 1) El método por lote existe y devuelve el ÚLTIMO pago por foto.
  check('lote: el store tiene getLatestPaymentsByUserPhotos', typeof realFileStore.getLatestPaymentsByUserPhotos === 'function');
  const latest = await realFileStore.getLatestPaymentsByUserPhotos(2, [660, 663, 662]);
  check('lote: devuelve un Map con el último pago por foto', latest instanceof Map && latest.get(660) && latest.get(660).id === 3 && latest.get(663).id === 2 && !latest.has(662), latest && [...(latest.keys ? latest.keys() : [])]);

  // 2) checkout-status con 4 fotos: misma respuesta que foto por foto.
  const r = await call('checkout-status', { photoIds: [660, 661, 662, 663] });
  const byId = {};
  for (const p of (r.data.photos || [])) byId[p.photoId] = p;
  check('lote: 660 es pending (el último pago manda, no el viejo completado)', byId[660] && byId[660].status === 'pending' && byId[660].paid === false, byId[660]);
  check('lote: 661 es completed por descarga, aunque no tenga pago', byId[661] && byId[661].status === 'completed' && byId[661].paid === true, byId[661]);
  check('lote: 662 es none sin pago ni descarga', byId[662] && byId[662].status === 'none' && byId[662].paid === false, byId[662]);
  check('lote: 663 es pending', byId[663] && byId[663].status === 'pending' && byId[663].paid === false, byId[663]);
  check('lote: paid global es false si alguna foto no está pagada', r.data.paid === false, r.data.paid);
  check('lote: las fotos vienen en el mismo orden pedido', (r.data.photos || []).map(p => p.photoId).join(',') === '660,661,662,663', (r.data.photos || []).map(p => p.photoId));

  // 3) Todas pagadas → paid global true.
  const r2 = await call('checkout-status', { photoIds: [661] });
  check('lote: una sola foto pagada → paid true', r2.data.paid === true && r2.data.photos.length === 1 && r2.data.photos[0].status === 'completed', r2.data);

  try { fs.unlinkSync(DB_FILE); } catch (_) {}
  console.log(`\nResultado: ${pass} pasaron, ${fail} fallaron.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); try { fs.unlinkSync(DB_FILE); } catch (_) {} process.exit(1); });
