// Pruebas del sistema de planes OnlyClick (contrato planes-contrato.md,
// 24 nov 2026; negocio en plan-precios-fotografos-2026-11-23.md).
// Cubre la sección 11 del contrato:
//  1. Config: tasas y topes de los 3 planes + legado; dueño exento.
//  2. Mínimo $50: createEvent/join/setEventPrice/setMyEventPrice.
//  3. Tope: Gratis con 2,000 fotos en el mes → upload 2,001 = 403.
//  4. Comisión guardada: venta confirmada guarda commissionRate 0.15
//     (Gratis) en descarga y pago; my-earnings reparte con 15%;
//     venta vieja sin tasa usa 0.10.
//  5. Gracia y baja perezosa: Lite vencido hace 1 día sigue Lite;
//     vencido hace 4 días → plan-status lo baja a Gratis y lo persiste.
//  6. Pago de plan: plan-select genera el link Clip al momento,
//     plan-payment-create (dueño, respaldo) reutiliza el link,
//     webhook activa Lite 30 días, plan-payment-mark-paid activa sin Clip.
//  7. list-photographers incluye plan/vencimiento/estado.
//  8. Frontend (jsdom, app.js real): pestaña "Mi plan" con el tope;
//     input de unirse con min=50 para no-dueño.
//  9. Avisos al dueño (campanita): solicitud nueva, plan elegido,
//     plan activado por webhook / plan-payment-status / mark-paid (sin
//     duplicar), plan vencido por la baja perezosa.
//  10. Link fallido y dos pendientes: plan-select sin link → 502 (nunca
//      éxito); plan-status lista los pendientes vivos; el frontend
//      dibuja un botón de pago por pendiente y el aviso de éxito solo
//      sale con link de verdad.
//  11. Supersede y vencimiento a 3 días (Orlan, 2026-11-25): al elegir
//      un plan con link, los demás pendientes se cancelan (solo queda
//      el último); un pendiente sin pagar vence a los 3 días y ya no se
//      muestra ni se activa solo (webhook / Verificar pago); el dueño
//      sí puede activarlo con "Marcar pagado" si el dinero llegó.
// Patrón de test/pagos-pendientes.test.js: clip.js y mailer.js mockeados
// con require.cache, fileStore real, dispatch, contadores manuales.
// No toca la red ni usa credenciales reales. Al final borra data/db.json
// y los archivos subidos por las pruebas, como los demás suites.
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

// ---- Mocks: Clip (con captura de llamadas) y mailer (con captura). ----
let clipStatus = 'CHECKOUT_COMPLETED';
let clipCalls = [];
let clipFail = false; // true = createCheckoutLink tira (Clip caído).
const saleEmails = [];
require.cache[clipPath] = { exports: {
  createCheckoutLink: async (opts) => { if (clipFail) throw new Error('Clip no disponible'); clipCalls.push(opts); return { payment_request_id: 'clip-test-1', payment_request_url: 'https://clip.test/pay' }; },
  getCheckout: async () => ({ status: clipStatus, receipt_no: 'TEST123' }),
} };
require.cache[mailerPath] = { exports: {
  sendResetEmail: async () => {},
  sendSaleEmail: async (m) => { saleEmails.push(m); },
  sendEmail: async () => {},
} };

// El adaptador local REAL se carga ANTES de instalar el mock del store.
const { fileStore: realFileStore } = require(storePath);
require.cache[storePath] = { exports: { getStore: () => realFileStore } };

const H = require(handlersPath);
const { dispatch } = H;
const { signToken } = require(path.join(libDir, 'auth.js'));

const OWNER = { id: 1, name: 'Ricardo Orlan López Velázquez', email: 'dust.since2026@gmail.com', role: 'photographer', isOwner: true, approved: true, displayName: 'Only Dust' };
const BUYER = { id: 2, name: 'Comprador Prueba', email: 'comprador@test.mx', role: 'athlete', isOwner: false, approved: true, displayName: '' };
const SANDY = { id: 3, name: 'Sandy Tenorio', email: 'sandy@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Sandy', plan: 'legado' };
const PHOTOG = { id: 4, name: 'Fotógrafo Normal', email: 'foto@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Foto', plan: 'gratis' };
const RICARDO = { id: 95, name: 'Ricardo Klef', email: 'klef@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Klef', plan: 'legado' };

let pass = 0, fail = 0;
const sectionCounts = {};
let section = '';
function check(name, cond, extra) {
  sectionCounts[section] = sectionCounts[section] || { pass: 0, fail: 0 };
  if (cond) { pass++; sectionCounts[section].pass++; console.log('  ✓ ' + name); }
  else { fail++; sectionCounts[section].fail++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;
const isoDaysFromNow = (d) => new Date(Date.now() + d * DAY).toISOString();
const ymNow = () => new Date().toISOString().slice(0, 7);
const ymPrev = () => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

// ---------------- Siembra del adaptador local real ----------------
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
function seedDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function readDb() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function baseDb(overrides) {
  const db = {
    users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO],
    events: [
      { id: 5, name: 'Carrera Dueño', photographerId: 1, freeMode: false, priceMxn: 50, eventDate: '2027-06-01', createdAt: '2026-11-24T00:00:00.000Z' },
      { id: 6, name: 'Carrera Fotógrafo', photographerId: 4, freeMode: false, priceMxn: 50, eventDate: '2027-06-01', createdAt: '2026-11-24T00:00:00.000Z' },
      { id: 7, name: 'Carrera Gratis', photographerId: 1, freeMode: true, priceMxn: 0, eventDate: '2027-06-01', createdAt: '2026-11-24T00:00:00.000Z' },
    ],
    photos: [],
    payments: [],
    downloads: [],
    views: [], payouts: [], announcements: [], discountCodes: [],
    eventPhotographers: [],
    planPayments: [],
    seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 1 },
  };
  if (overrides) Object.assign(db, overrides);
  return db;
}

async function call(route, body, userId, query) {
  return dispatch(route, { body: body || {}, query: query || {}, token: userId === null ? null : signToken(userId === undefined ? 2 : userId) });
}
async function callErr(route, body, userId, query) {
  try { const r = await call(route, body, userId, query); return { ok: true, result: r }; }
  catch (e) { return { ok: false, status: e.status, message: e.message }; }
}
function cleanup() {
  try {
    const db = readDb();
    for (const p of (db.photos || [])) {
      for (const f of [p.filePath, p.thumbPath]) { if (f) { try { fs.unlinkSync(f); } catch (_) {} } }
    }
  } catch (_) {}
  try { fs.unlinkSync(DB_FILE); } catch (_) {}
}

(async () => {
  // ================= 1. Config =================
  section = '1-config';
  console.log('\n[1] Config: tasas y topes');
  check('config: PLANS está exportado', !!H.PLANS, Object.keys(H));
  const P = H.PLANS || {};
  check('config: Gratis 15% / $0 / tope 2,000', P.gratis && P.gratis.commissionRate === 0.15 && P.gratis.monthlyFee === 0 && P.gratis.uploadCap === 2000, P.gratis);
  check('config: Lite 10% / $299 / tope 4,000', P.lite && P.lite.commissionRate === 0.10 && P.lite.monthlyFee === 299 && P.lite.uploadCap === 4000, P.lite);
  check('config: Pro 7% / $499 / tope 9,000', P.pro && P.pro.commissionRate === 0.07 && P.pro.monthlyFee === 499 && P.pro.uploadCap === 9000, P.pro);
  check('config: Legado 10% / $0 / tope 2,000 / no elegible', P.legado && P.legado.commissionRate === 0.10 && P.legado.monthlyFee === 0 && P.legado.uploadCap === 2000 && P.legado.selectable === false, P.legado);
  check('config: PLANS ya no lleva storageGb (los planes se miden por tope de fotos)', !('storageGb' in (P.gratis || {})) && !('storageGb' in (P.lite || {})) && !('storageGb' in (P.pro || {})) && !('storageGb' in (P.legado || {})), P);
  check('config: MIN_PHOTO_PRICE_MXN es 50', H.MIN_PHOTO_PRICE_MXN === 50, H.MIN_PHOTO_PRICE_MXN);
  check('config: PLAN_GRACE_DAYS es 3', H.PLAN_GRACE_DAYS === 3, H.PLAN_GRACE_DAYS);
  check('config: effectivePlan está exportado', typeof H.effectivePlan === 'function');
  if (typeof H.effectivePlan === 'function') {
    const ep = H.effectivePlan;
    const o = ep(OWNER);
    check('config: dueño → status owner, tasa 0.10, sin tope', o.status === 'owner' && o.commissionRate === 0.10 && o.uploadCap === Infinity, o);
    check('config: dueño → sin vencimiento', o.expiresAt === null && o.graceUntil === null, o);
    check('config: plan desconocido → gratis', ep({ plan: 'inexistente' }).plan === 'gratis' && ep({ plan: 'inexistente' }).status === 'active');
    check('config: plan ausente → gratis', ep({}).plan === 'gratis' && ep({}).commissionRate === 0.15);
    check('config: gratis → activo, 15%, tope 2,000', (() => { const g = ep({ plan: 'gratis' }); return g.status === 'active' && g.commissionRate === 0.15 && g.uploadCap === 2000; })(), ep({ plan: 'gratis' }));
    check('config: legado → activo, 10%, tope 2,000', (() => { const l = ep({ plan: 'legado' }); return l.status === 'active' && l.commissionRate === 0.10 && l.uploadCap === 2000; })(), ep({ plan: 'legado' }));
    check('config: lite vigente → activo, 10%, tope 4,000', (() => { const l = ep({ plan: 'lite', planExpiresAt: isoDaysFromNow(10) }); return l.status === 'active' && l.plan === 'lite' && l.commissionRate === 0.10 && l.uploadCap === 4000; })());
    check('config: effectivePlan devuelve todos los campos', (() => { const g = ep({ plan: 'gratis' }); return ['plan', 'label', 'commissionRate', 'monthlyFee', 'uploadCap', 'status', 'expiresAt', 'graceUntil'].every(k => k in g); })(), ep({ plan: 'gratis' }));
    check('config: effectivePlan ya no devuelve storageGb', (() => { const g = ep({ plan: 'gratis' }); return !('storageGb' in g); })(), ep({ plan: 'gratis' }));
  }
  // Reparto por tasa (contrato §4): $50 → Clip $2.03, neto $47.97.
  check('config: splitSale(50) default 10% → fotógrafo $43.17', H.splitSale(50).photographerShare === 43.17 && H.splitSale(50).orlanFee === 4.80 && H.splitSale(50).clipFee === 2.03, H.splitSale(50));
  check('config: splitSale(50, 0.15) → fotógrafo $40.77, Orlan $7.20', H.splitSale(50, 0.15).photographerShare === 40.77 && H.splitSale(50, 0.15).orlanFee === 7.20, H.splitSale(50, 0.15));
  check('config: splitSale(50, 0.07) → fotógrafo $44.61, Orlan $3.36', H.splitSale(50, 0.07).photographerShare === 44.61 && H.splitSale(50, 0.07).orlanFee === 3.36, H.splitSale(50, 0.07));
  check('config: splitDownload con commissionRate 0.15 usa 15%', H.splitDownload({ amount: 50, commissionRate: 0.15 }).photographerShare === 40.77, H.splitDownload({ amount: 50, commissionRate: 0.15 }));
  check('config: splitDownload sin tasa usa 0.10', H.splitDownload({ amount: 50 }).photographerShare === 43.17, H.splitDownload({ amount: 50 }));
  check('config: splitRewardSale(50, 50, 0.15) → fotógrafo $40.77', H.splitRewardSale(50, 50, 0.15).photographerShare === 40.77, H.splitRewardSale(50, 50, 0.15));

  // ================= 2. Mínimo $50 =================
  section = '2-minimo-50';
  console.log('\n[2] Precio mínimo $50');
  seedDb(baseDb());
  let e = await callErr('create-event', { name: 'Barato', sport: 'Carrera', eventDate: '2027-06-01', location: 'Ensenada', freeMode: false, priceMxn: 20 }, 4);
  check('mínimo: createEvent $20 a fotógrafo normal → 400', !e.ok && e.status === 400 && e.message === 'El precio mínimo por foto es $50 MXN.', e);
  e = await callErr('create-event', { name: 'Barato', sport: 'Carrera', eventDate: '2027-06-01', location: 'Ensenada', freeMode: false, priceMxn: 49 }, 4);
  check('mínimo: createEvent $49 a fotógrafo normal → 400', !e.ok && e.status === 400, e);
  e = await callErr('create-event', { name: 'Justo', sport: 'Carrera', eventDate: '2027-06-01', location: 'Ensenada', freeMode: false, priceMxn: 50 }, 4);
  check('mínimo: createEvent $50 a fotógrafo normal → 201 y precio 50', e.ok && e.result.status === 201 && e.result.data.event.priceMxn === 50, e.result && e.result.data);
  e = await callErr('create-event', { name: 'Sin precio', sport: 'Carrera', eventDate: '2027-06-01', location: 'Ensenada', freeMode: false }, 4);
  check('mínimo: createEvent sin precio (fotógrafo) → default $50', e.ok && e.result.data.event.priceMxn === 50, e.result && e.result.data);
  e = await callErr('create-event', { name: 'Dueño barato', sport: 'Carrera', eventDate: '2027-06-01', location: 'Ensenada', freeMode: false, priceMxn: 20 }, 1);
  check('mínimo: createEvent $20 al dueño → 201 y precio 20 (exento)', e.ok && e.result.status === 201 && e.result.data.event.priceMxn === 20, e.result && e.result.data);
  e = await callErr('create-event', { name: 'Gratis barato', sport: 'Carrera', eventDate: '2027-06-01', location: 'Ensenada', freeMode: true, priceMxn: 20 }, 4);
  check('mínimo: createEvent freeMode $20 → 201 (no se afecta)', e.ok && e.result.status === 201, e);
  e = await callErr('join-event', { eventId: 5, priceMxn: 20 }, 4);
  check('mínimo: join-event $20 → 400', !e.ok && e.status === 400 && e.message === 'El precio mínimo por foto es $50 MXN.', e);
  e = await callErr('join-event', { eventId: 5, priceMxn: 49 }, 4);
  check('mínimo: join-event $49 → 400', !e.ok && e.status === 400, e);
  e = await callErr('join-event', { eventId: 5, priceMxn: 50 }, 4);
  check('mínimo: join-event $50 → 200', e.ok && e.result.status === 200 && e.result.data.priceMxn === 50, e.result && e.result.data);
  e = await callErr('set-event-price', { eventId: 6, priceMxn: 20 }, 4);
  check('mínimo: set-event-price $20 → 400', !e.ok && e.status === 400 && e.message === 'El precio mínimo por foto es $50 MXN.', e);
  e = await callErr('set-event-price', { eventId: 6, priceMxn: 50 }, 4);
  check('mínimo: set-event-price $50 → 200 y precio 50', e.ok && e.result.status === 200 && e.result.data.event.priceMxn === 50, e.result && e.result.data);
  e = await callErr('set-my-event-price', { eventId: 5, priceMxn: 20 }, 4);
  check('mínimo: set-my-event-price $20 → 400', !e.ok && e.status === 400 && e.message === 'El precio mínimo por foto es $50 MXN.', e);
  e = await callErr('set-my-event-price', { eventId: 5, priceMxn: 50 }, 4);
  check('mínimo: set-my-event-price $50 → 200', e.ok && e.result.status === 200, e.result && e.result.data);
  e = await callErr('set-event-price', { eventId: 5, priceMxn: 20 }, 1);
  check('mínimo: set-event-price $20 al dueño → 200 (exento)', e.ok && e.result.status === 200 && e.result.data.event.priceMxn === 20, e.result && e.result.data);
  e = await callErr('set-my-event-price', { eventId: 5, priceMxn: 20 }, 1);
  check('mínimo: set-my-event-price $20 al dueño → 200 (exento)', e.ok && e.result.status === 200, e.result && e.result.data);

  // ================= 3. Tope de subida =================
  section = '3-tope';
  console.log('\n[3] Tope de subidas por mes');
  const photoBody = (eventId) => ({ eventId, dataBase64: Buffer.from('fake-jpeg').toString('base64'), mimeType: 'image/jpeg', filename: 't.jpg', bibs: ['7'] });
  // 2,000 fotos del fotógrafo Gratis (id 4) en el mes actual.
  const photos2000 = [];
  for (let i = 0; i < 2000; i++) {
    photos2000.push({ id: 1000 + i, eventId: 6, filename: 'f' + i + '.jpg', bibs: ['1'], price: 50, photographerId: 4, createdAt: ymNow() + '-15T10:00:00.000Z' });
  }
  seedDb(baseDb({ photos: photos2000, seq: { user: 100, event: 8, photo: 3000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 1 } }));
  check('tope: el store cuenta 2,000 fotos del mes (si existe el método)', typeof realFileStore.countPhotosByPhotographerInMonth !== 'function' || (await realFileStore.countPhotosByPhotographerInMonth(4, new Date().getUTCFullYear(), new Date().getUTCMonth() + 1)) === 2000, typeof realFileStore.countPhotosByPhotographerInMonth);
  e = await callErr('upload-photo', photoBody(6), 4);
  check('tope: upload 2,001 de Gratis → 403 con mensaje de tope', !e.ok && e.status === 403 && /Llegaste a tu tope de 2,?000 fotos este mes \(plan Gratis\)/.test(e.message || '') && /Sube de plan para seguir subiendo/.test(e.message || ''), e);
  e = await callErr('plan-status', {}, 4);
  check('tope: plan-status muestra uploadsUsed 2,000 y uploadsLeft 0', e.ok && e.result.data.uploadsUsed === 2000 && e.result.data.uploadsLeft === 0, e.result && e.result.data);
  e = await callErr('upload-photo', photoBody(5), 1);
  check('tope: el dueño sube sin tope → 201', e.ok && e.result.status === 201, e);
  // Mes nuevo: 2,000 fotos del mes pasado NO cuentan.
  const photosPrev = [];
  for (let i = 0; i < 2000; i++) {
    photosPrev.push({ id: 1000 + i, eventId: 6, filename: 'f' + i + '.jpg', bibs: ['1'], price: 50, photographerId: 4, createdAt: ymPrev() + '-15T10:00:00.000Z' });
  }
  seedDb(baseDb({ photos: photosPrev, seq: { user: 100, event: 8, photo: 3000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 1 } }));
  e = await callErr('upload-photo', photoBody(6), 4);
  check('tope: 2,000 fotos del mes pasado no cuentan → 201', e.ok && e.result.status === 201, e);
  e = await callErr('plan-status', {}, 4);
  check('tope: plan-status en mes nuevo muestra uploadsUsed 1', e.ok && e.result.data.uploadsUsed === 1 && e.result.data.uploadsLeft === 1999, e.result && e.result.data);

  // ================= 4. Comisión guardada =================
  section = '4-comision';
  console.log('\n[4] Comisión guardada en la venta');
  seedDb(baseDb({
    photos: [
      { id: 700, eventId: 6, filename: 'f700.jpg', bibs: ['354'], price: 50, photographerId: 4, createdAt: '2026-11-24T00:00:00.000Z' },
      { id: 701, eventId: 5, filename: 'f701.jpg', bibs: ['355'], price: 50, photographerId: 1, createdAt: '2026-11-24T00:00:00.000Z' },
    ],
    seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 1 },
  }));
  saleEmails.length = 0;
  e = await callErr('checkout-create', { photoId: 700 }, 2);
  check('comisión: checkout-create de foto Gratis $50 → link Clip', e.ok && e.result.data.checkoutUrl === 'https://clip.test/pay' && e.result.data.paymentRequestId === 'clip-test-1' && e.result.data.amount === 50, e.result && e.result.data);
  const wh = await callErr('clip-webhook', { id: 'clip-test-1' }, null);
  check('comisión: webhook confirma el pago', wh.ok && (wh.result.data.paid === true || wh.result.data.ok === true), wh.result && wh.result.data);
  let db = readDb();
  const dl = db.downloads.find(d => d.userId === 2 && d.photoId === 700);
  const pay = db.payments.find(p => p.userId === 2 && p.photoId === 700);
  check('comisión: la descarga guarda commissionRate 0.15 (Gratis)', !!dl && dl.commissionRate === 0.15, dl);
  check('comisión: el pago guarda commissionRate 0.15 y queda completed', !!pay && pay.commissionRate === 0.15 && pay.status === 'completed', pay);
  e = await callErr('my-earnings', {}, 4);
  check('comisión: my-earnings reparte con 15% → fotógrafo $40.77, Orlan $7.20, Clip $2.03', e.ok && e.result.data.totalSold === 50 && e.result.data.photographerShare === 40.77 && e.result.data.orlanFee === 7.20 && e.result.data.clipFee === 2.03, e.result && e.result.data);
  const saleMail = saleEmails.find(m => m && m.to === 'foto@test.mx');
  check('comisión: el correo de venta dice 15% de OnlyClick (no 10% fijo)', !!saleMail && /15% de OnlyClick/.test(saleMail.text || ''), saleMail && saleMail.text);
  // Venta del dueño: tasa histórica 0.10.
  e = await callErr('checkout-create', { photoId: 701 }, 2);
  check('comisión: checkout-create de foto del dueño → link Clip', e.ok && e.result.data.checkoutUrl === 'https://clip.test/pay', e.result && e.result.data);
  await callErr('clip-webhook', { id: 'clip-test-1' }, null);
  db = readDb();
  const dlOwner = db.downloads.find(d => d.userId === 2 && d.photoId === 701);
  check('comisión: la venta del dueño guarda commissionRate 0.10', !!dlOwner && dlOwner.commissionRate === 0.10, dlOwner);
  e = await callErr('my-earnings', {}, 1);
  check('comisión: my-earnings del dueño → fotógrafo $43.17 (10%)', e.ok && e.result.data.photographerShare === 43.17, e.result && e.result.data);
  // Venta vieja sin tasa: el reparto usa 0.10.
  seedDb(baseDb({
    downloads: [{ id: 1, userId: 2, photoId: 700, eventId: 6, amount: 50, createdAt: '2026-11-20T00:00:00.000Z' }],
    photos: [{ id: 700, eventId: 6, filename: 'f700.jpg', bibs: ['354'], price: 50, photographerId: 4, createdAt: '2026-11-20T00:00:00.000Z' }],
    seq: { user: 100, event: 8, photo: 1000, download: 2, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 1 },
  }));
  e = await callErr('my-earnings', {}, 4);
  check('comisión: venta vieja sin tasa usa 0.10 → fotógrafo $43.17', e.ok && e.result.data.photographerShare === 43.17 && e.result.data.orlanFee === 4.80, e.result && e.result.data);

  // ================= 5. Gracia y baja perezosa =================
  section = '5-gracia';
  console.log('\n[5] Gracia y baja perezosa');
  if (typeof H.effectivePlan === 'function') {
    const ep = H.effectivePlan;
    const g1 = ep({ plan: 'lite', planExpiresAt: isoDaysFromNow(-1) });
    check('gracia: Lite vencido hace 1 día → sigue Lite en gracia', g1.plan === 'lite' && g1.status === 'grace' && g1.commissionRate === 0.10 && g1.uploadCap === 4000, g1);
    check('gracia: graceUntil es vencimiento + 3 días', g1.graceUntil === new Date(new Date(isoDaysFromNow(-1)).getTime() + 3 * DAY).toISOString(), g1);
    const g4 = ep({ plan: 'lite', planExpiresAt: isoDaysFromNow(-4) });
    check('gracia: Lite vencido hace 4 días → efectivo Gratis, status expired', g4.plan === 'gratis' && g4.status === 'expired' && g4.commissionRate === 0.15 && g4.uploadCap === 2000, g4);
    const g0 = ep({ plan: 'pro', planExpiresAt: isoDaysFromNow(5) });
    check('gracia: Pro vigente → activo, 7%, tope 9,000', g0.plan === 'pro' && g0.status === 'active' && g0.commissionRate === 0.07 && g0.uploadCap === 9000, g0);
  } else {
    check('gracia: effectivePlan está exportado (para probar gracia pura)', false);
  }
  const LITE_GRACE = { id: 6, name: 'Lite Gracia', email: 'lite@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Lite', plan: 'lite', planExpiresAt: isoDaysFromNow(-1) };
  const LITE_EXPIRED = { id: 7, name: 'Lite Vencido', email: 'vencido@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Vencido', plan: 'lite', planExpiresAt: isoDaysFromNow(-4) };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO, LITE_GRACE, LITE_EXPIRED] }));
  e = await callErr('plan-status', {}, 6);
  check('gracia: plan-status en gracia → plan lite, status grace', e.ok && e.result.data.plan === 'lite' && e.result.data.status === 'grace' && e.result.data.commissionRate === 0.10, e.result && e.result.data);
  db = readDb();
  check('gracia: en gracia NO se persiste la baja (sigue lite en BD)', db.users.find(u => u.id === 6).plan === 'lite', db.users.find(u => u.id === 6));
  e = await callErr('plan-status', {}, 7);
  check('gracia: plan-status vencido hace 4 días → plan gratis', e.ok && e.result.data.plan === 'gratis', e.result && e.result.data);
  db = readDb();
  const downgraded = db.users.find(u => u.id === 7);
  check('gracia: la baja a Gratis se PERSISTE (plan gratis, sin vencimiento)', downgraded.plan === 'gratis' && (downgraded.planExpiresAt === null || downgraded.planExpiresAt === undefined), downgraded);
  e = await callErr('plan-status', {}, 4);
  check('gracia: plan-status de Gratis trae lista plans sin legado', e.ok && Array.isArray(e.result.data.plans) && e.result.data.plans.length === 3 && e.result.data.plans.map(p => p.id).join(',') === 'gratis,lite,pro' && e.result.data.pendingPayment === null, e.result && e.result.data);
  check('gracia: plan-status de Gratis → status active, uploadsUsed 0, uploadsLeft 2,000', e.ok && e.result.data.status === 'active' && e.result.data.uploadsUsed === 0 && e.result.data.uploadsLeft === 2000, e.result && e.result.data);
  e = await callErr('plan-status', {}, 1);
  check('gracia: plan-status del dueño → status owner, tasa 0.10', e.ok && e.result.data.status === 'owner' && e.result.data.commissionRate === 0.10, e.result && e.result.data);

  // ================= 6. Pago de plan =================
  section = '6-pago-plan';
  console.log('\n[6] Pago de plan (select → link Clip → activación)');
  const LITE_ACTIVE = { id: 6, name: 'Lite Activo', email: 'lite@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Lite', plan: 'lite', planExpiresAt: isoDaysFromNow(10) };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO, LITE_ACTIVE] }));
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'lite' }, 4);
  const pp1 = e.ok && (e.result.data.planPayment || e.result.data);
  check('pago: plan-select lite crea pendiente $299 CON link Clip', e.ok && pp1 && pp1.plan === 'lite' && pp1.amountMxn === 299 && pp1.status === 'pending' && pp1.id != null && pp1.paymentUrl === 'https://clip.test/pay', e.result && e.result.data);
  const clipCall = clipCalls[0] || {};
  check('pago: plan-select llama a Clip 1 vez: $299, "Plan Lite OnlyClick (1 mes)"', clipCalls.length === 1 && clipCall.amount === 299 && clipCall.purchase_description === 'Plan Lite OnlyClick (1 mes)', clipCall);
  const extRef = clipCall.metadata && clipCall.metadata.external_reference;
  check('pago: external_reference OC-PLAN-<id>-<azar>, máx 36 chars', typeof extRef === 'string' && /^OC-PLAN-\d+-[A-Za-z0-9]+$/.test(extRef) && extRef.length <= 36, extRef);
  check('pago: redirection success → /?plan=pagado, error → /?plan=error', clipCall.redirection_url && String(clipCall.redirection_url.success).endsWith('/?plan=pagado') && String(clipCall.redirection_url.error).endsWith('/?plan=error'), clipCall.redirection_url);
  db = readDb();
  check('pago: la fila plan_payments queda guardada con clipPaymentRequestId y paymentUrl', db.planPayments && db.planPayments.length === 1 && db.planPayments[0].plan === 'lite' && db.planPayments[0].clipPaymentRequestId === 'clip-test-1' && db.planPayments[0].paymentUrl === 'https://clip.test/pay', db.planPayments);
  e = await callErr('plan-select', { plan: 'lite' }, 4);
  const pp1b = e.ok && (e.result.data.planPayment || e.result.data);
  db = readDb();
  check('pago: segundo plan-select lite NO duplica (misma fila, mismo link, sin llamar a Clip)', e.ok && pp1b && pp1b.id === pp1.id && pp1b.paymentUrl === 'https://clip.test/pay' && db.planPayments.length === 1 && clipCalls.length === 1, { pp1b, count: db.planPayments.length, clipCalls: clipCalls.length });
  e = await callErr('plan-select', { plan: 'invalido' }, 4);
  check('pago: plan-select con plan inválido → 400', !e.ok && e.status === 400, e);
  e = await callErr('plan-select', { plan: 'legado' }, 4);
  check('pago: plan-select legado → 400 (no elegible)', !e.ok && e.status === 400, e);
  e = await callErr('plan-select', { plan: 'lite' }, 6);
  db = readDb();
  check('pago: plan-select lite con Lite ya activo → sin crear nada', e.ok && db.planPayments.length === 1, { data: e.result && e.result.data, count: db.planPayments.length });
  const callsBeforeGratis = clipCalls.length;
  e = await callErr('plan-select', { plan: 'gratis' }, 6);
  db = readDb();
  check('pago: plan-select gratis baja de inmediato (plan gratis, sin vencimiento) y no llama a Clip', e.ok && db.users.find(u => u.id === 6).plan === 'gratis' && (db.users.find(u => u.id === 6).planExpiresAt === null || db.users.find(u => u.id === 6).planExpiresAt === undefined) && clipCalls.length === callsBeforeGratis, { user: db.users.find(u => u.id === 6), clipCalls: clipCalls.length });
  // Link de Clip (respaldo del dueño: plan-select ya lo generó).
  e = await callErr('plan-payment-create', { planPaymentId: pp1.id }, 4);
  check('pago: plan-payment-create como fotógrafo → 403 (solo dueño)', !e.ok && e.status === 403, e);
  clipCalls = [];
  e = await callErr('plan-payment-create', { planPaymentId: pp1.id }, 1);
  check('pago: plan-payment-create (dueño) devuelve el MISMO link sin llamar a Clip', e.ok && e.result.data.paymentUrl === 'https://clip.test/pay' && e.result.data.planPayment && e.result.data.planPayment.id === pp1.id && clipCalls.length === 0, { data: e.result && e.result.data, clipCalls: clipCalls.length });
  db = readDb();
  const ppRow = db.planPayments.find(p => p.id === pp1.id);
  check('pago: la fila guarda clipPaymentRequestId y paymentUrl', ppRow && ppRow.clipPaymentRequestId === 'clip-test-1' && ppRow.paymentUrl === 'https://clip.test/pay', ppRow);
  clipCalls = [];
  e = await callErr('plan-payment-create', { planPaymentId: pp1.id }, 1);
  check('pago: segundo plan-payment-create reutiliza el link (sin llamar a Clip)', e.ok && e.result.data.paymentUrl === 'https://clip.test/pay' && clipCalls.length === 0, { data: e.result && e.result.data, clipCalls: clipCalls.length });
  e = await callErr('plan-status', {}, 4);
  check('pago: plan-status muestra el pendingPayment con link', e.ok && e.result.data.pendingPayment && e.result.data.pendingPayment.id === pp1.id && e.result.data.pendingPayment.plan === 'lite' && e.result.data.pendingPayment.amountMxn === 299 && e.result.data.pendingPayment.paymentUrl === 'https://clip.test/pay' && e.result.data.pendingPayment.status === 'pending', e.result && e.result.data);
  // Webhook de Clip activa Lite por 30 días.
  const beforeWh = Date.now();
  const wh2 = await callErr('clip-webhook', { id: 'clip-test-1' }, null);
  check('pago: webhook con el clip id del plan → ok', wh2.ok && wh2.result.data.ok === true, wh2.result && wh2.result.data);
  db = readDb();
  const user4 = db.users.find(u => u.id === 4);
  const ppRow2 = db.planPayments.find(p => p.id === pp1.id);
  const expMs = user4.planExpiresAt ? new Date(user4.planExpiresAt).getTime() : NaN;
  check('pago: webhook activa Lite (plan lite, vence en ~30 días)', user4.plan === 'lite' && Number.isFinite(expMs) && Math.abs(expMs - (beforeWh + 30 * DAY)) < 5 * 60 * 1000, user4);
  check('pago: webhook marca la fila completed con paidAt', ppRow2 && ppRow2.status === 'completed' && !!ppRow2.paidAt, ppRow2);
  // Marcar pagado a mano (sin Clip) activa Pro.
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'pro' }, 4);
  const ppPro = e.ok && (e.result.data.planPayment || e.result.data);
  check('pago: plan-select pro crea pendiente $499 CON link Clip (1 llamada)', e.ok && ppPro && ppPro.plan === 'pro' && ppPro.amountMxn === 499 && ppPro.paymentUrl === 'https://clip.test/pay' && clipCalls.length === 1, { data: e.result && e.result.data, clipCalls: clipCalls.length });
  clipCalls = [];
  e = await callErr('plan-payment-mark-paid', { planPaymentId: ppPro.id }, 4);
  check('pago: plan-payment-mark-paid como fotógrafo → 403 (solo dueño)', !e.ok && e.status === 403, e);
  const beforeMark = Date.now();
  e = await callErr('plan-payment-mark-paid', { planPaymentId: ppPro.id }, 1);
  db = readDb();
  const user4b = db.users.find(u => u.id === 4);
  const ppProRow = db.planPayments.find(p => p.id === ppPro.id);
  const expMs2 = user4b.planExpiresAt ? new Date(user4b.planExpiresAt).getTime() : NaN;
  check('pago: mark-paid activa Pro por 30 días sin llamar a Clip', e.ok && user4b.plan === 'pro' && Number.isFinite(expMs2) && Math.abs(expMs2 - (beforeMark + 30 * DAY)) < 5 * 60 * 1000 && clipCalls.length === 0, { user: user4b, clipCalls: clipCalls.length });
  check('pago: mark-paid marca la fila completed con paidAt', ppProRow && ppProRow.status === 'completed' && !!ppProRow.paidAt, ppProRow);
  // plan-payment-status: re-consulta Clip y activa.
  const PRO_USER = { id: 8, name: 'Pro Status', email: 'pro@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Pro', plan: 'gratis' };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO, PRO_USER] }));
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'pro' }, 8);
  const ppS = e.ok && (e.result.data.planPayment || e.result.data);
  check('pago: plan-select pro para usuario 8 → pendiente $499 CON link Clip', e.ok && ppS && ppS.plan === 'pro' && ppS.amountMxn === 499 && ppS.paymentUrl === 'https://clip.test/pay' && clipCalls.length === 1, { data: e.result && e.result.data, clipCalls: clipCalls.length });
  e = await callErr('plan-payment-create', { planPaymentId: ppS.id }, 1);
  check('pago: plan-payment-create pro → mismo link sin llamar a Clip', e.ok && e.result.data.paymentUrl === 'https://clip.test/pay' && clipCalls.length === 1, { data: e.result && e.result.data, clipCalls: clipCalls.length });
  e = await callErr('plan-payment-status', { planPaymentId: ppS.id }, 4);
  check('pago: plan-payment-status de otro fotógrafo → 403', !e.ok && e.status === 403, e);
  const beforeSt = Date.now();
  e = await callErr('plan-payment-status', { planPaymentId: ppS.id }, 8);
  db = readDb();
  const user8 = db.users.find(u => u.id === 8);
  const expMs3 = user8.planExpiresAt ? new Date(user8.planExpiresAt).getTime() : NaN;
  check('pago: plan-payment-status (Clip COMPLETED) activa Pro', e.ok && e.result.data.status === 'completed' && e.result.data.plan === 'pro' && user8.plan === 'pro' && Number.isFinite(expMs3) && Math.abs(expMs3 - (beforeSt + 30 * DAY)) < 5 * 60 * 1000, { data: e.result && e.result.data, user: user8 });
  // plan-payments (solo dueño).
  e = await callErr('plan-payments', {}, 4);
  check('pago: plan-payments como fotógrafo → 403 (solo dueño)', !e.ok && e.status === 403, e);
  e = await callErr('plan-payments', {}, 1);
  const list = e.ok && e.result.data.planPayments;
  check('pago: plan-payments (dueño) lista con nombre y campos', e.ok && Array.isArray(list) && list.length === 1 && list[0].photographerId === 8 && typeof list[0].photographerName === 'string' && list[0].plan === 'pro' && list[0].amountMxn === 499 && list[0].status === 'completed' && typeof list[0].createdAt === 'string', list);
  // Pendiente viejo SIN link (flujo anterior a este arreglo): plan-select
  // genera el link ahora, sin duplicar la fila.
  const LEGACY_USER = { id: 9, name: 'Legado Sin Link', email: 'legado@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Leg', plan: 'gratis' };
  const LEGACY_ROW = { id: 7, photographerId: 9, plan: 'lite', amountMxn: 299, clipPaymentRequestId: null, paymentUrl: null, status: 'pending', createdAt: isoDaysFromNow(-1), paidAt: null };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO, LEGACY_USER], planPayments: [LEGACY_ROW], seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 8 } }));
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'lite' }, 9);
  const ppLeg = e.ok && (e.result.data.planPayment || e.result.data);
  db = readDb();
  check('pago: plan-select con pendiente viejo sin link genera el link (misma fila)', e.ok && ppLeg && ppLeg.id === 7 && ppLeg.paymentUrl === 'https://clip.test/pay' && clipCalls.length === 1 && db.planPayments.length === 1, { ppLeg, clipCalls: clipCalls.length, count: db.planPayments.length });
  check('pago: la fila vieja ahora guarda clipPaymentRequestId y paymentUrl', db.planPayments[0] && db.planPayments[0].clipPaymentRequestId === 'clip-test-1' && db.planPayments[0].paymentUrl === 'https://clip.test/pay', db.planPayments[0]);
  // Webhook activa el plan de un pago creado por plan-select (no por el dueño).
  const beforeWhLeg = Date.now();
  const whLeg = await callErr('clip-webhook', { id: 'clip-test-1' }, null);
  db = readDb();
  const user9 = db.users.find(u => u.id === 9);
  const expMsLeg = user9.planExpiresAt ? new Date(user9.planExpiresAt).getTime() : NaN;
  check('pago: webhook activa Lite de un pago creado por plan-select', whLeg.ok && whLeg.result.data.ok === true && user9.plan === 'lite' && Number.isFinite(expMsLeg) && Math.abs(expMsLeg - (beforeWhLeg + 30 * DAY)) < 5 * 60 * 1000 && db.planPayments[0].status === 'completed', { user: user9, row: db.planPayments[0] });
  // Gratis no crea pago ni toca Clip.
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO] }));
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'gratis' }, 4);
  check('pago: plan-select gratis no crea pago ni llama a Clip', e.ok && e.result.data.planPayment === null && clipCalls.length === 0, { data: e.result && e.result.data, clipCalls: clipCalls.length });

  // ================= 7. list-photographers =================
  section = '7-list-photographers';
  console.log('\n[7] list-photographers con plan');
  const LITE_USER = { id: 6, name: 'Lite Activo', email: 'lite@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Lite', plan: 'lite', planExpiresAt: isoDaysFromNow(12) };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO, LITE_USER] }));
  e = await callErr('list-photographers', {}, 4);
  check('fotógrafos: list-photographers como fotógrafo → 403', !e.ok && e.status === 403, e);
  e = await callErr('list-photographers', {}, 1);
  const rows = e.ok && e.result.data.photographers;
  const byId = (id) => (rows || []).find(r => r.id === id);
  check('fotógrafos: Sandy (legado) → plan legado, 10%, activo', byId(3) && byId(3).plan === 'legado' && byId(3).planLabel === 'Legado (10%)' && byId(3).commissionRate === 0.10 && byId(3).planStatus === 'active', byId(3));
  check('fotógrafos: Ricardo (legado) → plan legado, 10%, activo', byId(95) && byId(95).plan === 'legado' && byId(95).planLabel === 'Legado (10%)' && byId(95).commissionRate === 0.10 && byId(95).planStatus === 'active', byId(95));
  check('fotógrafos: fotógrafo normal → plan gratis, 15%, activo', byId(4) && byId(4).plan === 'gratis' && byId(4).planLabel === 'Gratis' && byId(4).commissionRate === 0.15 && byId(4).planStatus === 'active', byId(4));
  check('fotógrafos: Lite vigente → plan lite, 10%, vencimiento y activo', byId(6) && byId(6).plan === 'lite' && byId(6).planLabel === 'Lite' && byId(6).commissionRate === 0.10 && byId(6).planExpiresAt === LITE_USER.planExpiresAt && byId(6).planStatus === 'active', byId(6));

  // ================= 8. Frontend (jsdom, app.js real) =================
  section = '8-frontend';
  console.log('\n[8] Frontend: pestaña Mi plan y mínimo $50');
  const { JSDOM } = require('/home/hatch/workspace/onlyclick-form-fotografos/node_modules/jsdom');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('frontend: existe la pestaña "Mi plan"', appJs.includes('Mi plan'));
  check('frontend: el panel pide /api/plan-status', appJs.includes('/api/plan-status'));
  check('frontend: el dueño ve "Eres el dueño: sin límites de plan"', appJs.includes('Eres el dueño: sin límites de plan'));
  check('frontend: banner ?plan=pagado dice "Pago recibido, tu plan se activó"', appJs.includes('Pago recibido, tu plan se activó'));
  check('frontend: banner ?plan=error dice "El pago no se completó, inténtalo de nuevo"', appJs.includes('El pago no se completó, inténtalo de nuevo'));
  check('frontend: al tope de subida hay botón "Ver mi plan"', appJs.includes('Ver mi plan'));
  check('frontend: pago pendiente trae botón "Verificar pago" (data-plan-verify, uno por pendiente)', appJs.includes('Verificar pago') && appJs.includes('data-plan-verify'));
  check('frontend: los precios de fotógrafo llevan "Mínimo $50 por foto" (no dueño)', appJs.includes('Mínimo $50 por foto'));
  check('frontend: index.html usa /app.js?v=20261124d', html.includes('/app.js?v=20261124d'));
  check('frontend: la tarjeta de plan muestra solo el tope de fotos, sin GB', appJs.includes('fotos subidas por mes') && !appJs.includes('storageGb'));
  const joinSeg = appJs.slice(Math.max(0, appJs.indexOf('joinPrice') - 200), appJs.indexOf('joinPrice') + 600);
  check('frontend: el input de unirse lleva min=50 para no-dueño', /min="\$\{me && me\.isOwner \? 1 : 50\}"/.test(joinSeg) || /id=\\"joinPrice\\"[^>]*min=\\"50\\"/.test(joinSeg), joinSeg.slice(0, 400));
  check('frontend: la tarjeta de unirse muestra "Mínimo $50 por foto" al no-dueño', joinSeg.includes('Mínimo $50 por foto'), joinSeg.slice(0, 600));

  // ---- Arranque jsdom con fetch simulado. ----
  const PLAN_STATUS_MOCK = { plan: 'gratis', label: 'Gratis', commissionRate: 0.15, monthlyFee: 0, uploadCap: 2000, uploadsUsed: 120, uploadsLeft: 1880, expiresAt: null, graceUntil: null, status: 'active', pendingPayment: null, plans: [
    { id: 'gratis', label: 'Gratis', commissionRate: 0.15, monthlyFee: 0, uploadCap: 2000 },
    { id: 'lite', label: 'Lite', commissionRate: 0.10, monthlyFee: 299, uploadCap: 4000 },
    { id: 'pro', label: 'Pro', commissionRate: 0.07, monthlyFee: 499, uploadCap: 9000 },
  ] };
  let authUser = PHOTOG;
  let mockPlanSelect = null; // respuesta que devuelve /api/plan-select en jsdom.
  let mockPlanSelectError = null; // mensaje de error (502) de /api/plan-select en jsdom.
  const EV5 = { id: 5, photographerId: 1, name: 'Carrera Dueño', sport: 'Carrera', eventDate: '2027-06-01', location: 'Ensenada', freeMode: false, priceMxn: 50, photoCount: 0 };
  function makeMock() {
    return async (url, opts) => {
      const [p] = String(url).split('?');
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (p === '/api/plan-select') {
        if (mockPlanSelectError) return { ok: false, json: async () => ({ error: mockPlanSelectError }) };
        return { ok: true, json: async () => (mockPlanSelect || {}) };
      }
      if (p === '/api/auth-status') return { ok: true, json: async () => ({ user: authUser }) };
      if (p === '/api/events') return { ok: true, json: async () => ({ events: [EV5] }) };
      if (p === '/api/event-get') return { ok: true, json: async () => ({ event: EV5, photos: [], totalPhotos: 0, photographerName: 'Only Dust', participants: [], isOfficial: true, isParticipant: false, myPrice: null, tipClabe: '', tipName: '' }) };
      if (p === '/api/checkout-status') return { ok: true, json: async () => ({ paid: false, photos: [] }) };
      if (p === '/api/my-photos') return { ok: true, json: async () => ({ photos: [] }) };
      if (p === '/api/my-pending-payments') return { ok: true, json: async () => ({ payments: [] }) };
      if (p === '/api/sales') return { ok: true, json: async () => ({ sales: [], totalDownloads: 0, freeDownloads: 0, revenue: 0 }) };
      if (p === '/api/stats') return { ok: true, json: async () => ({ totals: { photoViews: 0, uniqueViewers: 0, eventViews: 0, totalDownloads: 0, freeDownloads: 0, revenue: 0 }, events: [], topPhotos: [], topBibs: [] }) };
      if (p === '/api/my-earnings') return { ok: true, json: async () => ({ totalSold: 0, clipFee: 0, orlanFee: 0, photographerShare: 0, pendingBalance: 0, pendingSince: null, paidShare: 0, lastPayout: null }) };
      if (p === '/api/plan-status') return { ok: true, json: async () => (PLAN_STATUS_MOCK) };
      if (p === '/api/plan-payments') return { ok: true, json: async () => ({ planPayments: [] }) };
      if (p === '/api/list-photographers') return { ok: true, json: async () => ({ photographers: [] }) };
      if (p === '/api/payouts-summary') return { ok: true, json: async () => ({ photographers: [] }) };
      if (p === '/api/payouts-history') return { ok: true, json: async () => ({ payouts: [] }) };
      if (p === '/api/list-applications') return { ok: true, json: async () => ({ applications: [] }) };
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
  window.localStorage.setItem('onlyclick_token', 'test-token');
  const s = d.createElement('script');
  s.textContent = appJs;
  d.body.appendChild(s);
  await sleep(400);

  // ---- planSectionHtml directo (función global del app.js real). ----
  check('frontend: planSectionHtml es global', typeof window.planSectionHtml === 'function');
  if (typeof window.planSectionHtml === 'function') {
    const planHtml = window.planSectionHtml(PLAN_STATUS_MOCK, false);
    check('frontend: Mi plan muestra "120 de 2,000 fotos subidas este mes"', planHtml.includes('120 de 2,000 fotos subidas este mes'), planHtml.slice(0, 400));
    check('frontend: Mi plan muestra te quedan 1,880', planHtml.includes('1,880'), planHtml.slice(0, 400));
    check('frontend: Mi plan muestra las tarjetas Gratis/Lite/Pro con comisión y tope', planHtml.includes('Plan Gratis') && planHtml.includes('Plan Lite') && planHtml.includes('Plan Pro') && planHtml.includes('Comisión OnlyClick: 15%') && planHtml.includes('9,000 fotos'), planHtml.slice(0, 1200));
    check('frontend: Mi plan trae botón Elegir Lite / Elegir Pro', planHtml.includes('Elegir Lite') && planHtml.includes('Elegir Pro'), planHtml.slice(0, 2000));
    check('frontend: texto de cambiar de plan dice que el botón de pago aparece aquí mismo (sin Orlan)', planHtml.includes('el botón para pagar con Clip aparece aquí mismo') && !planHtml.includes('Orlan te manda el link'), planHtml.slice(0, 2000));
    const ownerHtml = window.planSectionHtml(PLAN_STATUS_MOCK, true);
    check('frontend: al dueño le muestra "Eres el dueño: sin límites de plan" (sin tarjetas)', ownerHtml.includes('Eres el dueño: sin límites de plan') && !ownerHtml.includes('Elegir Lite'), ownerHtml.slice(0, 300));
    const pendingHtml = window.planSectionHtml({ ...PLAN_STATUS_MOCK, pendingPayment: { id: 9, plan: 'lite', amountMxn: 299, paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: '2026-11-24T00:00:00.000Z' } }, false);
    check('frontend: con pago pendiente muestra botón dorado "Pagar $299 MXN con Clip" y "Verificar pago"', pendingHtml.includes('Pagar $299 MXN con Clip') && pendingHtml.includes('data-plan-payurl="https://clip.test/pay"') && pendingHtml.includes('Paga aquí con Clip y tu plan se activa solo') && pendingHtml.includes('Verificar pago') && pendingHtml.includes('data-plan-verify="9"'), pendingHtml.slice(0, 1200));
    const pendingNoLinkHtml = window.planSectionHtml({ ...PLAN_STATUS_MOCK, pendingPayment: { id: 10, plan: 'pro', amountMxn: 499, paymentUrl: null, status: 'pending', createdAt: '2026-11-24T00:00:00.000Z' } }, false);
    check('frontend: pendiente SIN link no muestra botón Pagar y avisa que Orlan manda el link', !pendingNoLinkHtml.includes('data-plan-payurl') && pendingNoLinkHtml.includes('Orlan te manda el link de pago de Clip'), pendingNoLinkHtml.slice(0, 900));
  }

  // ---- Panel real: la pestaña Mi plan se dibuja con el tope. ----
  check('frontend: loadPhotographer es global', typeof window.loadPhotographer === 'function');
  if (typeof window.loadPhotographer === 'function') {
    authUser = PHOTOG;
    if (typeof window.refreshAuth === 'function') await window.refreshAuth();
    await window.loadPhotographer();
    await sleep(200);
    const planSec = d.querySelector('[data-tabpanel="plan"]');
    check('frontend: el panel tiene sección data-tabpanel="plan" con título "Mi plan"', !!planSec && planSec.querySelector('h2') && planSec.querySelector('h2').textContent === 'Mi plan', planSec && planSec.innerHTML.slice(0, 200));
    check('frontend: la pestaña Mi plan dibuja "120 de 2,000 fotos subidas este mes"', !!planSec && planSec.innerHTML.includes('120 de 2,000 fotos subidas este mes'), planSec && planSec.innerHTML.slice(0, 500));
    check('frontend: el inicio del panel tiene la fila "Mi plan"', !!d.querySelector('#photoPanel') && d.querySelector('#photoPanel').innerHTML.includes('Mi plan'), d.querySelector('#photoPanel') && d.querySelector('#photoPanel').innerHTML.slice(0, 500));
  }

  // ---- Álbum: input de unirse con min=50 para no-dueño. ----
  check('frontend: loadEventDetail es global', typeof window.loadEventDetail === 'function');
  if (typeof window.loadEventDetail === 'function') {
    authUser = PHOTOG;
    if (typeof window.refreshAuth === 'function') await window.refreshAuth();
    await window.loadEventDetail(5);
    await sleep(300);
    const jp = d.getElementById('joinPrice');
    check('frontend: unirse (no-dueño) → input min=50 y valor 50', !!jp && jp.getAttribute('min') === '50' && jp.value === '50', jp && jp.outerHTML);
    check('frontend: unirse (no-dueño) → texto "Mínimo $50 por foto"', !!jp && d.getElementById('eventDetail').innerHTML.includes('Mínimo $50 por foto'));
    authUser = OWNER;
    if (typeof window.refreshAuth === 'function') await window.refreshAuth();
    await window.loadEventDetail(5);
    await sleep(300);
    const jpOwner = d.getElementById('joinPrice');
    check('frontend: unirse (dueño) → sin mínimo (min=1, sin texto de $50)', !jpOwner || (jpOwner.getAttribute('min') === '1' && !d.getElementById('eventDetail').innerHTML.includes('Mínimo $50 por foto')), jpOwner && jpOwner.outerHTML);
  }

  // ---- Banner ?plan=pagado / ?plan=error. ----
  const alerts = [];
  const dom2 = new JSDOM(html, { url: 'https://onlyclick-zeta.vercel.app/?plan=pagado', runScripts: 'dangerously', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.fetch = makeMock();
  w2.URL.createObjectURL = () => 'blob:fake';
  w2.URL.revokeObjectURL = () => {};
  w2.confirm = () => true;
  w2.alert = (m) => alerts.push(m);
  w2.HTMLElement.prototype.scrollIntoView = function () {};
  w2.localStorage.setItem('onlyclick_token', 'test-token');
  const s2 = w2.document.createElement('script');
  s2.textContent = appJs;
  w2.document.body.appendChild(s2);
  await sleep(400);
  check('frontend: ?plan=pagado avisa "Pago recibido, tu plan se activó"', alerts.some(a => String(a).includes('Pago recibido, tu plan se activó')), alerts);
  check('frontend: ?plan=pagado limpia el parámetro de la URL', w2.location.search === '', w2.location.search);

  // ================= 9. Avisos al dueño (campanita) =================
  section = '9-avisos-dueno';
  console.log('\n[9] Avisos al dueño: solicitud, cambio de plan, vencimiento');
  let notes;
  async function ownerNotes(re) {
    const all = await realFileStore.listAnnouncements();
    return all.filter(a => Number(a.userId) === 1 && re.test(a.title || ''));
  }

  // 1. Solicitud de fotógrafo nuevo → campanita del dueño (además del correo).
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO] }));
  e = await callErr('submit-application', { name: 'Ana Nueva', city: 'Tijuana, BC', phone: '6641112233', events: 'Carreras 5K', sampleLink: 'https://instagram.com/ana' }, null);
  check('avisos: submit-application → 201', e.ok && e.result.data.ok === true && e.result.data.id != null, e.result && e.result.data);
  notes = await ownerNotes(/Nuevo fotógrafo quiere unirse/);
  check('avisos: solicitud crea aviso al dueño "Nuevo fotógrafo quiere unirse: Ana Nueva"', notes.length === 1 && notes[0].title === 'Nuevo fotógrafo quiere unirse: Ana Nueva' && Number(notes[0].userId) === 1, notes);
  e = await callErr('list-announcements', {}, 1);
  check('avisos: la campanita del dueño lista el aviso de solicitud', e.ok && (e.result.data.announcements || []).some(a => a.title === 'Nuevo fotógrafo quiere unirse: Ana Nueva'), e.result && e.result.data);
  e = await callErr('list-announcements', {}, 4);
  check('avisos: la campanita del fotógrafo NO ve el aviso del dueño', e.ok && !(e.result.data.announcements || []).some(a => (a.title || '').includes('Nuevo fotógrafo quiere unirse')), e.result && e.result.data);

  // 2. plan-select crea pendiente → aviso al dueño; re-selección no duplica; gratis no avisa.
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO] }));
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'lite' }, 4);
  notes = await ownerNotes(/eligió el plan Lite, pendiente de pago/);
  check('avisos: plan-select lite avisa "Foto eligió el plan Lite, pendiente de pago" con $299', notes.length === 1 && notes[0].title === 'Foto eligió el plan Lite, pendiente de pago' && /299/.test(notes[0].body || ''), notes);
  e = await callErr('plan-select', { plan: 'lite' }, 4);
  notes = await ownerNotes(/eligió el plan Lite, pendiente de pago/);
  check('avisos: segundo plan-select lite NO duplica el aviso', notes.length === 1, notes);
  e = await callErr('plan-select', { plan: 'gratis' }, 4);
  notes = await ownerNotes(/eligió el plan/);
  check('avisos: plan-select gratis no avisa', notes.length === 1, notes);

  // 3. Activación por webhook → aviso; los otros dos caminos no duplican.
  const whA = await callErr('clip-webhook', { id: 'clip-test-1' }, null);
  notes = await ownerNotes(/activó el plan Lite/);
  check('avisos: webhook activa Lite y avisa "Foto activó el plan Lite"', whA.ok && notes.length === 1 && notes[0].title === 'Foto activó el plan Lite', notes);
  await callErr('clip-webhook', { id: 'clip-test-1' }, null);
  notes = await ownerNotes(/activó el plan Lite/);
  check('avisos: segundo webhook NO duplica el aviso de activación', notes.length === 1, notes);
  const ppLite = (readDb().planPayments || []).find(p => p.plan === 'lite');
  await callErr('plan-payment-status', { planPaymentId: ppLite.id }, 4);
  notes = await ownerNotes(/activó el plan Lite/);
  check('avisos: plan-payment-status sobre fila completada NO duplica', notes.length === 1, notes);
  await callErr('plan-payment-mark-paid', { planPaymentId: ppLite.id }, 1);
  notes = await ownerNotes(/activó el plan Lite/);
  check('avisos: mark-paid sobre fila completada NO duplica', notes.length === 1, notes);

  // 3b. Activación por mark-paid (primer camino) y por plan-payment-status (primer camino).
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO] }));
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'pro' }, 4);
  const ppMark = e.ok && (e.result.data.planPayment || e.result.data);
  await callErr('plan-payment-mark-paid', { planPaymentId: ppMark.id }, 1);
  notes = await ownerNotes(/activó el plan Pro/);
  check('avisos: mark-paid activa Pro y avisa "Foto activó el plan Pro"', notes.length === 1 && notes[0].title === 'Foto activó el plan Pro', notes);
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO] }));
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'pro' }, 4);
  const ppSt = e.ok && (e.result.data.planPayment || e.result.data);
  await callErr('plan-payment-status', { planPaymentId: ppSt.id }, 4);
  notes = await ownerNotes(/activó el plan Pro/);
  check('avisos: plan-payment-status activa Pro y avisa "Foto activó el plan Pro"', notes.length === 1 && notes[0].title === 'Foto activó el plan Pro', notes);
  e = await callErr('list-announcements', {}, 1);
  check('avisos: la campanita del dueño lista el aviso de activación', e.ok && (e.result.data.announcements || []).some(a => a.title === 'Foto activó el plan Pro'), e.result && e.result.data);

  // 4. Baja perezosa: plan-status vence el plan → aviso una sola vez.
  const LITE_VENCIDO2 = { id: 7, name: 'Lite Vencido', email: 'vencido@test.mx', role: 'photographer', isOwner: false, approved: true, displayName: 'Vencido', plan: 'lite', planExpiresAt: isoDaysFromNow(-4) };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO, LITE_VENCIDO2] }));
  e = await callErr('plan-status', {}, 7);
  notes = await ownerNotes(/venció y bajó a Gratis/);
  check('avisos: plan-status con plan vencido avisa "El plan de Vencido venció y bajó a Gratis"', e.ok && notes.length === 1 && notes[0].title === 'El plan de Vencido venció y bajó a Gratis', notes);
  await callErr('plan-status', {}, 7);
  notes = await ownerNotes(/venció y bajó a Gratis/);
  check('avisos: segundo plan-status ya en Gratis NO repite el aviso', notes.length === 1, notes);

  // ================= 10. Link fallido y dos pendientes =================
  section = '10-doble-pendiente';
  console.log('\n[10] Link de Clip fallido y dos pagos pendientes');
  // (a) Clip caído al elegir Lite: plan-select FALLA (502), no avisa
  // éxito; la fila queda pendiente sin link y sin aviso al dueño.
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO] }));
  clipCalls = [];
  clipFail = true;
  e = await callErr('plan-select', { plan: 'lite' }, 4);
  check('doble: plan-select lite con Clip caído → 502 "No se pudo generar el link de pago"', !e.ok && e.status === 502 && /No se pudo generar el link de pago de Clip/.test(e.message || ''), e);
  db = readDb();
  check('doble: la fila queda pendiente SIN link (el dueño puede generarlo después)', db.planPayments.length === 1 && db.planPayments[0].plan === 'lite' && db.planPayments[0].status === 'pending' && db.planPayments[0].paymentUrl == null, db.planPayments);
  notes = await ownerNotes(/eligió el plan Lite, pendiente de pago/);
  check('doble: plan-select fallido NO avisa al dueño (no hay pago listo)', notes.length === 0, notes);
  e = await callErr('plan-status', {}, 4);
  check('doble: plan-status muestra el pendiente sin link en pendingPayments', e.ok && Array.isArray(e.result.data.pendingPayments) && e.result.data.pendingPayments.length === 1 && e.result.data.pendingPayments[0].paymentUrl == null && e.result.data.pendingPayment && e.result.data.pendingPayment.paymentUrl == null, e.result && e.result.data);
  clipFail = false;
  // Reintento: el mismo plan-select genera el link en la misma fila.
  e = await callErr('plan-select', { plan: 'lite' }, 4);
  const ppRetry = e.ok && (e.result.data.planPayment || e.result.data);
  check('doble: reintento de plan-select genera el link en la misma fila (sin duplicar)', e.ok && ppRetry && ppRetry.id === 1 && ppRetry.paymentUrl === 'https://clip.test/pay' && readDb().planPayments.length === 1, { ppRetry, count: readDb().planPayments.length });
  // (b) Segundo pendiente: Pro. El Lite viejo se CANCELA (solo queda
  // pendiente el último que se generó, Orlan 2026-11-25).
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'pro' }, 4);
  const ppPro2 = e.ok && (e.result.data.planPayment || e.result.data);
  check('doble: plan-select pro crea el pendiente $499 CON link', e.ok && ppPro2 && ppPro2.plan === 'pro' && ppPro2.amountMxn === 499 && ppPro2.paymentUrl === 'https://clip.test/pay' && ppPro2.id === 2, { ppPro2, count: readDb().planPayments.length });
  db = readDb();
  const liteOld = db.planPayments.find(p => p.id === 1);
  check('doble: el pendiente Lite viejo queda cancelado (status cancelled)', liteOld && liteOld.status === 'cancelled', liteOld);
  e = await callErr('plan-status', {}, 4);
  const pps = e.ok && e.result.data.pendingPayments;
  check('doble: plan-status lista SOLO el pendiente Pro (el Lite ya no sale)', e.ok && Array.isArray(pps) && pps.length === 1 && pps[0].plan === 'pro' && pps[0].paymentUrl === 'https://clip.test/pay', e.result && e.result.data);
  check('doble: plan-status mantiene pendingPayment (el más nuevo, Pro) por compatibilidad', e.ok && e.result.data.pendingPayment && e.result.data.pendingPayment.plan === 'pro' && e.result.data.pendingPayment.id === ppPro2.id, e.result && e.result.data);
  e = await callErr('plan-payments', {}, 1);
  const ownerList = e.ok && e.result.data.planPayments;
  check('doble: plan-payments (dueño) tampoco muestra el Lite cancelado', e.ok && Array.isArray(ownerList) && ownerList.length === 1 && ownerList[0].plan === 'pro' && ownerList[0].status === 'pending', ownerList);
  // (c) Frontend: dos botones de pago y aviso de éxito solo con link.
  if (typeof window.planSectionHtml === 'function') {
    const twoHtml = window.planSectionHtml({ ...PLAN_STATUS_MOCK, pendingPayment: { id: 2, plan: 'pro', amountMxn: 499, paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: '2026-11-24T00:00:00.000Z' }, pendingPayments: [
      { id: 2, plan: 'pro', amountMxn: 499, paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: '2026-11-24T00:00:00.000Z' },
      { id: 1, plan: 'lite', amountMxn: 299, paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: '2026-11-24T00:00:00.000Z' },
    ] }, false);
    check('doble: Mi plan con dos pendientes dibuja "Pagar $499" y "Pagar $299" (dos data-plan-payurl)', twoHtml.includes('Pagar $499 MXN con Clip') && twoHtml.includes('Pagar $299 MXN con Clip') && (twoHtml.match(/data-plan-payurl=/g) || []).length === 2, twoHtml.slice(0, 1500));
    check('doble: cada pendiente trae su propio "Verificar pago" (data-plan-verify 2 y 1)', (twoHtml.match(/data-plan-verify="/g) || []).length === 2 && twoHtml.includes('data-plan-verify="2"') && twoHtml.includes('data-plan-verify="1"'), twoHtml.slice(0, 1500));
    check('doble: el más nuevo (Pro) sale primero que el viejo (Lite)', twoHtml.indexOf('Pagar $499 MXN con Clip') !== -1 && twoHtml.indexOf('Pagar $499 MXN con Clip') < twoHtml.indexOf('Pagar $299 MXN con Clip'), twoHtml.slice(0, 1500));
    const oldHtml = window.planSectionHtml({ ...PLAN_STATUS_MOCK, pendingPayment: { id: 9, plan: 'lite', amountMxn: 299, paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: '2026-11-24T00:00:00.000Z' } }, false);
    check('doble: sin pendingPayments (contrato viejo) sigue dibujando el único pendiente', oldHtml.includes('Pagar $299 MXN con Clip') && (oldHtml.match(/data-plan-payurl=/g) || []).length === 1 && oldHtml.includes('data-plan-verify="9"'), oldHtml.slice(0, 1200));
  }
  // Clic real en "Elegir Lite": aviso de éxito SOLO con link.
  if (typeof window.loadPhotographer === 'function') {
    const clickedAlerts = [];
    window.alert = (m) => clickedAlerts.push(String(m));
    authUser = PHOTOG;
    if (typeof window.refreshAuth === 'function') await window.refreshAuth();
    // Con link: éxito.
    mockPlanSelectError = null;
    mockPlanSelect = { ok: true, plan: 'lite', planPayment: { id: 9, plan: 'lite', amountMxn: 299, paymentUrl: 'https://clip.test/pay', status: 'pending' } };
    await window.loadPhotographer();
    await sleep(200);
    let liteBtn = d.querySelector('[data-plan-select="lite"]');
    check('doble: el panel dibuja el botón Elegir Lite', !!liteBtn);
    if (liteBtn) { liteBtn.click(); await sleep(300); }
    check('doble: elegir Lite CON link avisa "Tu pago del plan está listo"', clickedAlerts.some(a => a.includes('Tu pago del plan está listo')), clickedAlerts);
    // Sin link: error, nunca éxito.
    clickedAlerts.length = 0;
    mockPlanSelect = { ok: true, plan: 'lite', planPayment: { id: 9, plan: 'lite', amountMxn: 299, paymentUrl: null, status: 'pending' } };
    await window.loadPhotographer();
    await sleep(200);
    liteBtn = d.querySelector('[data-plan-select="lite"]');
    if (liteBtn) { liteBtn.click(); await sleep(300); }
    check('doble: elegir Lite SIN link avisa "No se pudo generar el link" y NO avisa éxito', clickedAlerts.some(a => a.includes('No se pudo generar el link')) && !clickedAlerts.some(a => a.includes('Tu pago del plan está listo')), clickedAlerts);
    // Error 502 del servidor: el catch muestra el mensaje del servidor.
    clickedAlerts.length = 0;
    mockPlanSelect = null;
    mockPlanSelectError = 'No se pudo generar el link de pago de Clip. Inténtalo de nuevo.';
    await window.loadPhotographer();
    await sleep(200);
    liteBtn = d.querySelector('[data-plan-select="lite"]');
    if (liteBtn) { liteBtn.click(); await sleep(300); }
    check('doble: elegir Lite con error 502 muestra el mensaje del servidor (sin aviso de éxito)', clickedAlerts.some(a => a.includes('No se pudo generar el link de pago de Clip')) && !clickedAlerts.some(a => a.includes('Tu pago del plan está listo')), clickedAlerts);
    mockPlanSelectError = null;
  }

  // ================= 11. Supersede y vencimiento a 3 días =================
  section = '11-supersede-vencimiento';
  console.log('\n[11] Supersede y vencimiento a 3 días');
  check('vencimiento: PLAN_PENDING_EXPIRY_DAYS es 3', H.PLAN_PENDING_EXPIRY_DAYS === 3, H.PLAN_PENDING_EXPIRY_DAYS);
  // (a) Caso Sandy: dos pendientes frescos heredados (Pro id 1 y Lite
  // id 2). Al volver a picar Lite, se reutiliza el Lite y el Pro viejo
  // se cancela; el panel del dueño ya no lo muestra.
  const SANDY_PRO = { id: 1, photographerId: 4, plan: 'pro', amountMxn: 499, clipPaymentRequestId: 'clip-test-1', paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: isoDaysFromNow(-1), paidAt: null };
  const SANDY_LITE = { id: 2, photographerId: 4, plan: 'lite', amountMxn: 299, clipPaymentRequestId: 'clip-test-1', paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: isoDaysFromNow(0), paidAt: null };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO], planPayments: [SANDY_PRO, SANDY_LITE], seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 3 } }));
  clipCalls = [];
  e = await callErr('plan-select', { plan: 'lite' }, 4);
  const ppSandy = e.ok && (e.result.data.planPayment || e.result.data);
  check('supersede: re-picar Lite reutiliza la fila Lite (sin llamar a Clip)', e.ok && ppSandy && ppSandy.id === 2 && ppSandy.paymentUrl === 'https://clip.test/pay' && clipCalls.length === 0, { ppSandy, clipCalls: clipCalls.length });
  db = readDb();
  check('supersede: el pendiente Pro viejo queda cancelado', db.planPayments.find(p => p.id === 1).status === 'cancelled', db.planPayments);
  e = await callErr('plan-status', {}, 4);
  check('supersede: plan-status lista SOLO el Lite (el Pro cancelado no sale)', e.ok && e.result.data.pendingPayments.length === 1 && e.result.data.pendingPayments[0].plan === 'lite', e.result && e.result.data);
  e = await callErr('plan-payments', {}, 1);
  check('supersede: plan-payments (dueño) lista SOLO el Lite', e.ok && e.result.data.planPayments.length === 1 && e.result.data.planPayments[0].plan === 'lite' && e.result.data.planPayments[0].status === 'pending', e.result && e.result.data);
  // (b) Vencimiento: pendiente de hace 4 días se vence al leerlo;
  // pendiente de hace 2 días sigue vivo.
  const OLD_ROW = { id: 1, photographerId: 4, plan: 'lite', amountMxn: 299, clipPaymentRequestId: 'clip-test-1', paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: isoDaysFromNow(-4), paidAt: null };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO], planPayments: [OLD_ROW], seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 2 } }));
  e = await callErr('plan-status', {}, 4);
  check('vencimiento: pendiente de hace 4 días ya NO sale en plan-status', e.ok && e.result.data.pendingPayments.length === 0 && e.result.data.pendingPayment === null, e.result && e.result.data);
  db = readDb();
  check('vencimiento: la fila vieja queda marcada expired en BD', db.planPayments[0].status === 'expired', db.planPayments[0]);
  e = await callErr('plan-payments', {}, 1);
  check('vencimiento: plan-payments (dueño) tampoco muestra el vencido', e.ok && e.result.data.planPayments.length === 0, e.result && e.result.data);
  const FRESH_ROW = { id: 1, photographerId: 4, plan: 'lite', amountMxn: 299, clipPaymentRequestId: 'clip-test-1', paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: isoDaysFromNow(-2), paidAt: null };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO], planPayments: [FRESH_ROW], seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 2 } }));
  e = await callErr('plan-status', {}, 4);
  check('vencimiento: pendiente de hace 2 días SIGUE vivo en plan-status', e.ok && e.result.data.pendingPayments.length === 1 && e.result.data.pendingPayments[0].status === 'pending', e.result && e.result.data);
  db = readDb();
  check('vencimiento: la fila de hace 2 días sigue pending en BD', db.planPayments[0].status === 'pending', db.planPayments[0]);
  // (c) Webhook con Clip COMPLETED sobre una fila vencida: NO activa.
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO], planPayments: [OLD_ROW], seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 2 } }));
  clipStatus = 'CHECKOUT_COMPLETED';
  const whExp = await callErr('clip-webhook', { id: 'clip-test-1' }, null);
  check('vencimiento: webhook sobre fila vencida NO activa (paid false, status expired)', whExp.ok && whExp.result.data.ok === true && whExp.result.data.paid === false && whExp.result.data.status === 'expired', whExp.result && whExp.result.data);
  db = readDb();
  check('vencimiento: webhook marca la fila expired y el plan sigue gratis', db.planPayments[0].status === 'expired' && db.users.find(u => u.id === 4).plan === 'gratis', { row: db.planPayments[0], user: db.users.find(u => u.id === 4) });
  // (d) "Verificar pago" sobre fila vencida o cancelada: NO consulta
  // Clip ni activa; devuelve el estado tal cual.
  clipCalls = [];
  e = await callErr('plan-payment-status', { planPaymentId: 1 }, 4);
  check('vencimiento: plan-payment-status sobre fila vencida → status expired, sin activar', e.ok && e.result.data.status === 'expired' && readDb().users.find(u => u.id === 4).plan === 'gratis', e.result && e.result.data);
  const CXL_ROW = { id: 1, photographerId: 4, plan: 'pro', amountMxn: 499, clipPaymentRequestId: 'clip-test-1', paymentUrl: 'https://clip.test/pay', status: 'cancelled', createdAt: isoDaysFromNow(-1), paidAt: null };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO], planPayments: [CXL_ROW], seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 2 } }));
  clipCalls = [];
  e = await callErr('plan-payment-status', { planPaymentId: 1 }, 4);
  check('vencimiento: plan-payment-status sobre fila cancelada → status cancelled, sin llamar a Clip', e.ok && e.result.data.status === 'cancelled' && clipCalls.length === 0 && readDb().users.find(u => u.id === 4).plan === 'gratis', { data: e.result && e.result.data, clipCalls: clipCalls.length });
  // (e) "Marcar pagado" del dueño SÍ activa una fila vencida si el
  // dinero llegó a Clip (excepción aprobada por Orlan).
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO], planPayments: [OLD_ROW], seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 2 } }));
  await callErr('plan-status', {}, 4); // vence la fila en BD (lazy)
  db = readDb();
  check('vencimiento: plan-status dejó la fila expired antes del mark-paid', db.planPayments[0].status === 'expired', db.planPayments[0]);
  e = await callErr('plan-payment-mark-paid', { planPaymentId: 1 }, 1);
  db = readDb();
  check('vencimiento: mark-paid del dueño activa Lite aunque la fila estaba vencida', e.ok && db.users.find(u => u.id === 4).plan === 'lite' && db.planPayments[0].status === 'completed' && !!db.planPayments[0].paidAt, { user: db.users.find(u => u.id === 4), row: db.planPayments[0] });
  // (f) Clip caído al elegir Pro con un Lite pendiente: el Lite viejo
  // se CONSERVA (el reintento lo reutiliza); al reintentar con Clip
  // arriba, el Pro nuevo cancela el Lite.
  const LITE_KEEP = { id: 1, photographerId: 4, plan: 'lite', amountMxn: 299, clipPaymentRequestId: 'clip-test-1', paymentUrl: 'https://clip.test/pay', status: 'pending', createdAt: isoDaysFromNow(-1), paidAt: null };
  seedDb(baseDb({ users: [OWNER, BUYER, SANDY, PHOTOG, RICARDO], planPayments: [LITE_KEEP], seq: { user: 100, event: 8, photo: 1000, download: 1, payment: 1, view: 1, payout: 1, announcement: 1, discountCode: 1, planPayment: 2 } }));
  clipCalls = [];
  clipFail = true;
  e = await callErr('plan-select', { plan: 'pro' }, 4);
  check('supersede: plan-select pro con Clip caído → 502', !e.ok && e.status === 502, e);
  db = readDb();
  check('supersede: con Clip caído el Lite viejo SIGUE pending (no se cancela)', db.planPayments.find(p => p.id === 1).status === 'pending' && db.planPayments.find(p => p.plan === 'pro').status === 'pending' && db.planPayments.find(p => p.plan === 'pro').paymentUrl == null, db.planPayments);
  clipFail = false;
  e = await callErr('plan-select', { plan: 'pro' }, 4);
  const ppProRetry = e.ok && (e.result.data.planPayment || e.result.data);
  db = readDb();
  check('supersede: reintento con Clip arriba genera el link del Pro y cancela el Lite', e.ok && ppProRetry && ppProRetry.plan === 'pro' && ppProRetry.paymentUrl === 'https://clip.test/pay' && db.planPayments.find(p => p.id === 1).status === 'cancelled', { ppProRetry, rows: db.planPayments });
  e = await callErr('plan-status', {}, 4);
  check('supersede: tras el reintento plan-status lista SOLO el Pro', e.ok && e.result.data.pendingPayments.length === 1 && e.result.data.pendingPayments[0].plan === 'pro', e.result && e.result.data);

  cleanup();
  console.log('\nPor sección:');
  for (const [k, v] of Object.entries(sectionCounts)) console.log(`  ${k}: ${v.pass} pasaron, ${v.fail} fallaron`);
  console.log(`\nResultado: ${pass} pasaron, ${fail} fallaron.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); cleanup(); process.exit(1); });
