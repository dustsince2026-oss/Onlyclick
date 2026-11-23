// Prueba del orden Lite-primero en la lectura de dorsales (Orlan,
// 2026-11-22). readBib probaba ['gemini-3.8-flash', 'gemini-3.6-flash',
// 'gemini-3.5-flash-lite'] y costaba ~$0.14 MXN/foto (~$81 por carrera
// de 580 fotos). El Lite cuesta $0.30/millón de tokens de entrada contra
// $0.75 del 3.8 (2.5x más barato) y el 3.8 sube al doble el 1 ene 2027;
// con Lite primero la carrera sale ~$35. Reglas que se cubren (con fetch
// simulado, sin tocar la red ni usar credenciales reales):
// - El primer modelo intentado es gemini-3.5-flash-lite.
// - Con 503 (o 429) del Lite se pasa al 3.8 y se usa su respuesta.
// - Con otros errores (p. ej. 402) NO se reintenta con otro modelo.
// - geminiVisionJson (búsqueda por selfie) NO se tocó: sigue con el
//   3.8 primero. El prompt de readBib tampoco cambió.
'use strict';
const path = require('path');
const fs = require('fs');

process.env.AUTH_SECRET = 'test-secret-onlyclick';
process.env.CLIP_API_KEY = 'test-clip-key';
process.env.CLIP_API_SECRET = 'test-clip-secret';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';

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

const { fileStore: realFileStore } = require(storePath);
require.cache[storePath] = { exports: { getStore: () => realFileStore } };

const { dispatch } = require(handlersPath);
const { signToken } = require(path.join(libDir, 'auth.js'));

const OWNER = { id: 1, name: 'Ricardo Orlan López Velázquez', email: 'dust.since2026@gmail.com', role: 'photographer', isOwner: true, approved: true, displayName: 'Only Dust' };

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TINY_JPEG_B64 = Buffer.from('foto-falsa-para-prueba').toString('base64');

function geminiOk(bibs) {
  return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ bibs }) }] } }] }) };
}
function geminiErr(status, message) {
  return { ok: false, status, json: async () => ({ error: { message: message || ('error ' + status) } }) };
}

// fetch simulado: script es un arreglo de respuestas (ok o error) en
// orden; models registra el modelo de cada llamada.
function mockFetch(script) {
  const models = [];
  global.fetch = async (url) => {
    const m = String(url).match(/\/models\/([^:]+):generateContent/);
    models.push(m ? m[1] : String(url));
    const next = script.shift();
    return next;
  };
  return models;
}

async function callReadBib() {
  return dispatch('read-bib', { body: { dataBase64: TINY_JPEG_B64 }, query: {}, token: signToken(1) });
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const prevDb = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, 'utf8') : null;
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: [OWNER], events: [], photos: [], payments: [], downloads: [] }, null, 2));
  const realFetch = global.fetch;
  try {
    // 1) El Lite responde: es el primero y el único intento.
    let models = mockFetch([geminiOk(['387'])]);
    let r = await callReadBib();
    check('primer intento es gemini-3.5-flash-lite', models.length === 1 && models[0] === 'gemini-3.5-flash-lite', models);
    check('con Lite OK devuelve los dorsales', r && r.data && r.data.ok === true && JSON.stringify(r.data.bibs) === '["387"]', r && r.data);

    // 2) Lite 503 -> pasa al 3.8 y usa su respuesta.
    models = mockFetch([geminiErr(503, 'saturado'), geminiOk(['284'])]);
    r = await callReadBib();
    check('con 503 del Lite pasa al 3.8', JSON.stringify(models) === '["gemini-3.5-flash-lite","gemini-3.8-flash"]', models);
    check('con 3.8 OK devuelve los dorsales', r && r.data && r.data.ok === true && JSON.stringify(r.data.bibs) === '["284"]', r && r.data);

    // 3) Lite 429 -> también pasa al 3.8 (límite reintenta).
    models = mockFetch([geminiErr(429, 'límite'), geminiOk(['380'])]);
    r = await callReadBib();
    check('con 429 del Lite pasa al 3.8', JSON.stringify(models) === '["gemini-3.5-flash-lite","gemini-3.8-flash"]', models);
    check('con 429 y 3.8 OK devuelve los dorsales', r && r.data && r.data.ok === true && JSON.stringify(r.data.bibs) === '["380"]', r && r.data);

    // 4) Lite 402 -> NO reintenta (no es saturación ni límite).
    models = mockFetch([geminiErr(402, 'prepayment credits are depleted')]);
    r = await callReadBib();
    check('con 402 del Lite NO reintenta con otro modelo', models.length === 1 && models[0] === 'gemini-3.5-flash-lite', models);
    check('con 402 devuelve ia-error con status 402', r && r.data && r.data.ok === false && r.data.reason === 'ia-error' && r.data.status === 402, r && r.data);

    // 5) Guardas de no-regresión en el fuente: geminiVisionJson intacto
    // (3.8 primero) y el prompt de readBib sin cambios.
    const src = fs.readFileSync(handlersPath, 'utf8');
    const liteFirst = (src.match(/const MODELS = \['gemini-3\.5-flash-lite', 'gemini-3\.8-flash', 'gemini-3\.6-flash'\];/g) || []).length;
    const oldOrder = (src.match(/const MODELS = \['gemini-3\.8-flash', 'gemini-3\.6-flash', 'gemini-3\.5-flash-lite'\];/g) || []).length;
    check('readBib es el único MODELS con Lite primero', liteFirst === 1, liteFirst);
    check('geminiVisionJson sigue con 3.8 primero (no se tocó)', oldOrder === 1, oldOrder);
    check('el prompt de readBib no cambió', src.includes('lee TODOS los números de dorsal que llevan los corredores en el pecho'), '');
  } finally {
    global.fetch = realFetch;
    if (prevDb === null) { try { fs.unlinkSync(DB_FILE); } catch (_) {} }
    else fs.writeFileSync(DB_FILE, prevDb);
  }

  console.log(`\nResultado: ${pass} pasaron, ${fail} fallaron.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
