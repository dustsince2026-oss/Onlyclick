// Pruebas del arreglo "pagué y me salió error" (Orlan, 2026-11-22).
// Cuando Clip tarda en confirmar, el comprador veía mensajes que
// sonaban a error y creía que le habían cobrado; además la app lo
// dejaba pagar de nuevo y generaba varios intentos pendientes (un
// comprador creó 3 pendientes en 1 minuto antes de que el 4º pasara).
// Reglas que se cubren:
//  BACKEND — GET /api/my-pending-payments:
//  - Lista solo los pagos EN PROCESO del usuario (no los completados
//    ni los de otros usuarios).
//  - No lista un pendiente cuya foto ya es suya (otro intento posterior
//    ya se confirmó y la foto está en Mis fotos).
//  - Exige sesión (sin token → 401) y devuelve [] si no hay pendientes.
//  FRONTEND (jsdom, app.js real):
//  - Los mensajes nuevos dicen "No se realizó el cobro" (palabras de
//    Orlan) y "No pagues de nuevo"; los textos viejos que sonaban a
//    error ya no están; nunca aparece "no se te cobró".
//  - El flujo normal de pago exitoso queda intacto: sigue el
//    "¡Pago confirmado! Descargando tu foto…".
//  - En la cuadrícula, una foto con pago pendiente muestra el botón
//    "Verificar pago" (data-verify) EN VEZ del de comprar: no hay
//    data-save ni "Agregar al carrito" para esa foto. Una foto normal
//    sigue con "Pagar y descargar".
//  - En la vista ampliada, una foto con pendiente pone "Verificar pago"
//    en el botón principal (#lbSave).
//  - "Mis fotos" muestra el aviso de pagos en proceso solo cuando hay
//    pendientes, con su botón "Verificar pago"; sin pendientes no hay
//    aviso nuevo.
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
const OTHER = { id: 3, name: 'Otro Comprador', email: 'otro@test.mx', role: 'athlete', isOwner: false, approved: true, displayName: '' };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- Siembra del adaptador local real ----------------
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
function seedDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function call(route, body, userId) {
  return dispatch(route, { body: body || {}, query: {}, token: userId === null ? null : signToken(userId === undefined ? 2 : userId) });
}

(async () => {
  seedDb({
    users: [OWNER, BUYER, OTHER],
    events: [
      { id: 5, name: 'Prueba 2', photographerId: 1, freeMode: false, priceMxn: 25, eventDate: '2027-06-01' },
    ],
    photos: [
      { id: 660, eventId: 5, filename: 'f660.jpg', bibs: ['354'], price: 25, photographerId: 1 },
      { id: 661, eventId: 5, filename: 'f661.jpg', bibs: ['355'], price: 25, photographerId: 1 },
      { id: 662, eventId: 5, filename: 'f662.jpg', bibs: ['356'], price: 25, photographerId: 1 },
      { id: 663, eventId: 5, filename: 'f663.jpg', bibs: ['357'], price: 25, photographerId: 1 },
    ],
    // 660: pendiente del comprador (el caso real de hoy). 661: pago
    // completado (no es pendiente). 662: pendiente PERO con descarga
    // (otro intento posterior ya se confirmó: no se muestra). 663:
    // pendiente de OTRO usuario.
    payments: [
      { id: 1, userId: 2, photoId: 661, eventId: 5, amount: 25, status: 'completed', clipPaymentRequestId: 'clip-a', receiptNo: 'R1', createdAt: '2026-11-22T00:00:00.000Z' },
      { id: 2, userId: 2, photoId: 660, eventId: 5, amount: 25, status: 'pending', clipPaymentRequestId: 'clip-b', receiptNo: '', createdAt: '2026-11-22T00:01:00.000Z' },
      { id: 3, userId: 2, photoId: 662, eventId: 5, amount: 25, status: 'pending', clipPaymentRequestId: 'clip-c', receiptNo: '', createdAt: '2026-11-22T00:02:00.000Z' },
      { id: 4, userId: 3, photoId: 663, eventId: 5, amount: 25, status: 'pending', clipPaymentRequestId: 'clip-d', receiptNo: '', createdAt: '2026-11-22T00:03:00.000Z' },
    ],
    downloads: [
      { id: 1, userId: 2, photoId: 662, eventId: 5, amount: 25, createdAt: '2026-11-22T00:02:30.000Z' },
    ],
    views: [], payouts: [], announcements: [], discountCodes: [],
    seq: { user: 4, event: 6, photo: 664, download: 2, payment: 5, view: 1, payout: 1, announcement: 1, discountCode: 1 },
  });

  // ---- Backend: el método del store existe (ambas implementaciones
  // lo llevan; aquí se prueba el adaptador local). ----
  check('endpoint: el store tiene listPendingPaymentsByUser', typeof realFileStore.listPendingPaymentsByUser === 'function');
  const rows = await realFileStore.listPendingPaymentsByUser(2);
  check('endpoint: el store lista solo los pendientes del usuario', Array.isArray(rows) && rows.map(r => r.photoId).join(',') === '662,660', rows && rows.map(r => r.photoId));

  // ---- Backend: GET /api/my-pending-payments. ----
  const r = await call('my-pending-payments', {});
  check('endpoint: devuelve solo el pendiente sin descarga (660)', Array.isArray(r.data.payments) && r.data.payments.length === 1 && r.data.payments[0].photoId === 660, r.data);
  check('endpoint: cada pago trae photoId, eventId, amount y createdAt', r.data.payments.length === 1 && r.data.payments[0].eventId === 5 && r.data.payments[0].amount === 25 && typeof r.data.payments[0].createdAt === 'string', r.data.payments[0]);
  check('endpoint: el pendiente con descarga (662) NO se muestra', !(r.data.payments || []).some(p => p.photoId === 662));
  check('endpoint: el completado (661) NO se muestra', !(r.data.payments || []).some(p => p.photoId === 661));
  const rOther = await call('my-pending-payments', {}, 3);
  check('endpoint: otro usuario ve solo su pendiente (663)', Array.isArray(rOther.data.payments) && rOther.data.payments.length === 1 && rOther.data.payments[0].photoId === 663, rOther.data);
  const rOwner = await call('my-pending-payments', {}, 1);
  check('endpoint: sin pendientes devuelve lista vacía', Array.isArray(rOwner.data.payments) && rOwner.data.payments.length === 0, rOwner.data);
  let err401 = null;
  try { await call('my-pending-payments', {}, null); } catch (e) { err401 = e; }
  check('endpoint: sin sesión devuelve 401', err401 && err401.status === 401, err401 && err401.status);

  // ---------------- Frontend (jsdom, app.js real) ----------------
  const { JSDOM } = require('/home/hatch/workspace/onlyclick-form-fotografos/node_modules/jsdom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  // ---- Textos: los nuevos existen, los viejos que asustaban no. ----
  const NEW_STRINGS = [
    'El pago no se completó (cancelado o vencido). No se realizó el cobro. Puedes intentarlo de nuevo con "Pagar y descargar".',
    'No pudimos confirmar tu pago todavía. No pagues de nuevo: revisa "Mis fotos" en unos minutos o pica "Verificar pago".',
    'Tu pago está en proceso. No pagues de nuevo: en cuanto Clip lo confirme, la foto aparecerá en "Mis fotos".',
    'Clip todavía no confirma tu pago. No pagues de nuevo, inténtalo en unos minutos.',
    'No se pudo verificar el pago. No pagues de nuevo, inténtalo en unos minutos.',
    'No se realizó el cobro. Tu carrito sigue intacto, puedes intentarlo de nuevo.',
  ];
  for (const s of NEW_STRINGS) check('textos: existe el mensaje nuevo «' + s.slice(0, 40) + '…»', appJs.includes(s));
  const OLD_STRINGS = [
    'No se pudo verificar el pago. Revisa "Mis fotos" en unos minutos; si no aparece, inténtalo de nuevo.',
    'No se pudo verificar el pago todavía. Revisa "Mis fotos" en unos minutos.',
    'No se pudo verificar el pago, inténtalo de nuevo.',
    'Clip todavía no confirma tu pago, inténtalo en unos minutos.',
    'El pago no se completó (cancelado o vencido). Tu carrito sigue intacto, puedes intentarlo de nuevo.',
    'Tu pago está en proceso. En cuanto Clip lo confirme, la foto aparecerá en "Mis fotos".',
  ];
  for (const s of OLD_STRINGS) check('textos: ya no está el mensaje viejo «' + s.slice(0, 40) + '…»', !appJs.includes(s));
  check('textos: nunca dice "no se te cobró" (palabras de Orlan: "no se realizó el cobro")', !/no se te cobr[oó]/i.test(appJs));
  check('textos: el flujo normal sigue igual ("¡Pago confirmado! Descargando tu foto…")', appJs.includes('¡Pago confirmado! Descargando tu foto…'));

  // ---- Arranque jsdom con fetch simulado. ----
  const EV5 = { id: 5, photographerId: 1, name: 'Prueba 2', sport: 'Carrera', eventDate: '2027-06-01', location: 'Ensenada', freeMode: false, priceMxn: 25, photoCount: 2 };
  const PHOTO_660 = { id: 660, eventId: 5, filename: 'f660.jpg', bibs: ['354'], price: 25, priceMxn: 25, photographerId: 1, photographerName: 'Only Dust' };
  const PHOTO_661 = { id: 661, eventId: 5, filename: 'f661.jpg', bibs: ['355'], price: 25, priceMxn: 25, photographerId: 1, photographerName: 'Only Dust' };
  let pendingMock = [{ photoId: 660, eventId: 5, amount: 25, createdAt: '2026-11-22T00:01:00.000Z' }];
  function makeMock() {
    return async (url, opts) => {
      const [p] = String(url).split('?');
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (p === '/api/auth-status') return { ok: true, json: async () => ({ user: BUYER }) };
      if (p === '/api/events') return { ok: true, json: async () => ({ events: [EV5] }) };
      if (p === '/api/event-get') return { ok: true, json: async () => ({ event: EV5, photos: [PHOTO_660, PHOTO_661], totalPhotos: 2, photographerName: 'Only Dust', participants: [], isOfficial: true, isParticipant: false, myPrice: 25, tipClabe: '', tipName: '' }) };
      if (p === '/api/checkout-status') {
        const ids = Array.isArray(body.photoIds) ? body.photoIds : [body.photoId];
        return { ok: true, json: async () => ({ paid: false, photos: ids.map(id => ({ photoId: id, paid: false, status: id === 660 ? 'pending' : 'none' })) }) };
      }
      if (p === '/api/my-photos') return { ok: true, json: async () => ({ photos: [] }) };
      if (p === '/api/my-pending-payments') return { ok: true, json: async () => ({ payments: pendingMock }) };
      return { ok: true, json: async () => ({}) };
    };
  }
  const dom = new JSDOM(html, { url: 'https://onlyclick-zeta.vercel.app/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const d = window.document;
  window.fetch = makeMock();
  window.URL.createObjectURL = () => 'blob:fake';
  window.URL.revokeObjectURL = () => {};
  window.confirm = () => true;
  window.alert = () => {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  // Sin token en localStorage, markPendingPhotos y el chequeo de la
  // vista ampliada salen antes por `if (!token ...)`: el usuario real
  // sí tiene token tras iniciar sesión.
  window.localStorage.setItem('onlyclick_token', 'test-token');
  const s = d.createElement('script');
  s.textContent = appJs;
  d.body.appendChild(s);
  await sleep(400); // arranque: refreshAuth + loadHome

  // ---- Cuadrícula: la foto con pendiente cambia el botón. ----
  check('frontend: photoCard es global', typeof window.photoCard === 'function');
  if (typeof window.photoCard === 'function') {
    const pendingHtml = window.photoCard({ ...PHOTO_660, freeMode: false, _pending: true }, {});
    check('botón: la foto con pendiente dice "Verificar pago"', pendingHtml.includes('Verificar pago'), pendingHtml);
    check('botón: la foto con pendiente lleva data-verify (no data-save)', pendingHtml.includes('data-verify="660"') && !pendingHtml.includes('data-save="660"'), pendingHtml);
    check('botón: la foto con pendiente NO ofrece "Agregar al carrito"', !pendingHtml.includes('Agregar al carrito'), pendingHtml);
    check('botón: la foto con pendiente NO dice "Pagar y descargar"', !pendingHtml.includes('Pagar y descargar'), pendingHtml);
    const normalHtml = window.photoCard({ ...PHOTO_661, freeMode: false }, {});
    check('botón: la foto normal sigue con "Pagar y descargar · $25 MXN"', normalHtml.includes('Pagar y descargar · $25 MXN') && normalHtml.includes('data-save="661"'), normalHtml);
    const freeHtml = window.photoCard({ ...PHOTO_661, freeMode: true }, {});
    check('botón: la foto gratis no cambia ("Guardar gratis")', freeHtml.includes('Guardar gratis'), freeHtml);
  }

  // ---- Álbum en vivo (jsdom): el botón cambia al cargar. ----
  check('frontend: loadEventDetail es global', typeof window.loadEventDetail === 'function');
  if (typeof window.loadEventDetail === 'function') {
    await window.loadEventDetail(5);
    await sleep(300);
    const vBtn = d.querySelector('[data-verify="660"]');
    check('álbum: la foto 660 (pendiente) muestra "Verificar pago"', !!vBtn && vBtn.textContent.includes('Verificar pago'), vBtn && vBtn.textContent);
    check('álbum: la foto 660 (pendiente) ya NO tiene botón de comprar', !d.querySelector('[data-save="660"]'));
    const buyBtn = d.querySelector('[data-save="661"]');
    check('álbum: la foto 661 (normal) sigue con "Pagar y descargar"', !!buyBtn && buyBtn.textContent.includes('Pagar y descargar'), buyBtn && buyBtn.textContent);
  }

  // ---- Vista ampliada: el botón principal pasa a verificar. ----
  check('frontend: openLightbox es global', typeof window.openLightbox === 'function');
  if (typeof window.openLightbox === 'function') {
    window.openLightbox({ ...PHOTO_660, freeMode: false });
    await sleep(300);
    const lbSave = d.getElementById('lbSave');
    check('lightbox: el botón principal dice "Verificar pago" con pendiente', lbSave && lbSave.textContent === 'Verificar pago', lbSave && lbSave.textContent);
    window.openLightbox({ ...PHOTO_661, freeMode: false });
    await sleep(300);
    const lbSave2 = d.getElementById('lbSave');
    check('lightbox: sin pendiente el botón sigue "Pagar y descargar"', lbSave2 && lbSave2.textContent.includes('Pagar y descargar'), lbSave2 && lbSave2.textContent);
  }

  // ---- Mis fotos: aviso solo cuando hay pendientes. ----
  check('frontend: loadMyPhotos es global', typeof window.loadMyPhotos === 'function');
  if (typeof window.loadMyPhotos === 'function') {
    pendingMock = [{ photoId: 660, eventId: 5, amount: 25, createdAt: '2026-11-22T00:01:00.000Z' }];
    await window.loadMyPhotos();
    await sleep(100);
    const listHtml = d.getElementById('myPhotosList').innerHTML;
    check('mis fotos: con pendiente hay aviso "1 pago en proceso"', listHtml.includes('1 pago en proceso'), listHtml.slice(0, 300));
    check('mis fotos: el aviso dice "No pagues de nuevo"', listHtml.includes('No pagues de nuevo'));
    check('mis fotos: el aviso trae botón "Verificar pago" para la foto 660', !!d.querySelector('#myPhotosList [data-verify="660"]'));
    pendingMock = [];
    await window.loadMyPhotos();
    await sleep(100);
    const listHtml2 = d.getElementById('myPhotosList').innerHTML;
    check('mis fotos: sin pendientes NO hay aviso nuevo', !listHtml2.includes('pago en proceso') && !listHtml2.includes('No pagues de nuevo'), listHtml2.slice(0, 300));
  }

  try { fs.unlinkSync(DB_FILE); } catch (_) {}
  console.log(`\nResultado: ${pass} pasaron, ${fail} fallaron.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); try { fs.unlinkSync(DB_FILE); } catch (_) {} process.exit(1); });
