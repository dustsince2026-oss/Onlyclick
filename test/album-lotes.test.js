// Prueba de frontend: el álbum se abre por lotes (jsdom).
// Carga public/index.html + public/app.js como <script> clásico (igual
// que el navegador), con fetch simulado. Comprueba (Orlan 2026-11-22:
// el álbum de 512 fotos tardaba muchísimo en abrir porque bajaba todas
// las fotos de un jalón):
// - Al abrir un álbum de 130 fotos el servidor devuelve solo la primera
//   página de 60 y se ve "Ver más fotos" con "Mostrando 60 de 130 fotos".
// - Cada toque de "Ver más fotos" pide la siguiente página (60, luego
//   10) y al llegar al total el botón se esconde.
// - Con un álbum chico (20 fotos) no aparece el botón.
// - Al buscar por dorsal, los resultados reemplazan la cuadrícula y el
//   botón "Ver más fotos" se esconde.
const { JSDOM } = require('/home/hatch/workspace/onlyclick-form-fotografos/node_modules/jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ORLAN = { id: 1, name: 'Ricardo Orlan López Velázquez', email: 'orlan@test.mx', role: 'photographer', isOwner: true, approved: true };

function makePhotos(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ id: 1000 + i, bibs: [387], priceMxn: 40, photographerName: 'Only Dust', freeMode: false });
  return out;
}
const EVENT = { id: 6, name: 'CANACINTRA 3ra carrera atlética 2026', sport: 'Carrera', eventDate: '2026-11-22', location: 'Ensenada b.c.', freeMode: false, priceMxn: 40, photographerId: 1, isOfficial: true, isHidden: false, isUpcoming: false, isExclusive: false };

async function boot(photoCount) {
  const dom = new JSDOM(html, { url: 'https://onlyclick-zeta.vercel.app/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const d = window.document;
  window.fetch = async (url, opts) => {
    const [p] = String(url).split('?');
    if (p === '/api/auth-status') return { ok: true, json: async () => ({ user: ORLAN }) };
    if (p === '/api/events') return { ok: true, json: async () => ({ events: [EVENT] }) };
    if (p === '/api/event-get') {
      // El mock respeta limit/offset como el servidor real y devuelve
      // totalPhotos con el total del álbum.
      const q = new URLSearchParams(String(url).split('?')[1] || '');
      const limit = Number(q.get('limit'));
      const offset = Number(q.get('offset')) || 0;
      const all = makePhotos(photoCount);
      const page = Number.isFinite(limit) && limit > 0 ? all.slice(offset, offset + limit) : all;
      return { ok: true, json: async () => ({ event: EVENT, photos: page, totalPhotos: all.length, isParticipant: true, photographerName: 'Only Dust', participants: [{ displayName: 'Only Dust', priceMxn: 40 }] }) };
    }
    if (p === '/api/search') return { ok: true, json: async () => ({ photos: makePhotos(3).slice(0, 3) }) };
    if (p === '/api/checkout-status') return { ok: true, json: async () => ({ photos: [] }) };
    return { ok: true, json: async () => ({}) };
  };
  window.URL.createObjectURL = () => 'blob:fake';
  window.URL.revokeObjectURL = () => {};
  window.open = () => null;
  window.confirm = () => true;
  window.alert = () => {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const s = d.createElement('script');
  s.textContent = appJs;
  d.body.appendChild(s);
  await sleep(400);
  return { window, d };
}

(async () => {
  // 1) Álbum grande (130 fotos): primer lote de 60 + "Ver más".
  {
    const t = await boot(130);
    await t.window.loadEventDetail(6);
    await sleep(100);
    const grid = t.d.querySelector('#evGrid');
    check('130 fotos: al abrir solo se dibujan 60 tarjetas', grid.querySelectorAll('.photo').length === 60, grid.querySelectorAll('.photo').length);
    const btn = t.d.querySelector('#evMoreBtn');
    check('130 fotos: se ve el botón "Ver más fotos"', !!btn && btn.textContent.includes('Ver más fotos'));
    const count = t.d.querySelector('#evMoreCount');
    check('130 fotos: el conteo dice "Mostrando 60 de 130 fotos"', !!count && count.textContent === 'Mostrando 60 de 130 fotos', count && count.textContent);
    btn.onclick();
    await sleep(100);
    check('130 fotos: tras un toque hay 120 tarjetas', grid.querySelectorAll('.photo').length === 120, grid.querySelectorAll('.photo').length);
    check('130 fotos: el conteo dice "Mostrando 120 de 130 fotos"', count.textContent === 'Mostrando 120 de 130 fotos', count.textContent);
    btn.onclick();
    await sleep(100);
    check('130 fotos: tras dos toques hay 130 tarjetas', grid.querySelectorAll('.photo').length === 130, grid.querySelectorAll('.photo').length);
    const wrap = t.d.querySelector('#evMoreWrap');
    check('130 fotos: al llegar al total el botón se esconde', wrap.style.display === 'none', wrap.style.display);
    // 2) Buscar por dorsal esconde el botón y muestra los resultados.
    await t.window.runBibSearch('387');
    await sleep(100);
    check('búsqueda dorsal: la cuadrícula muestra 3 fotos', grid.querySelectorAll('.photo').length === 3, grid.querySelectorAll('.photo').length);
    check('búsqueda dorsal: el botón "Ver más" sigue escondido', wrap.style.display === 'none', wrap.style.display);
  }

  // 3) Álbum chico (20 fotos): no hay botón.
  {
    const t = await boot(20);
    await t.window.loadEventDetail(6);
    await sleep(100);
    const grid = t.d.querySelector('#evGrid');
    check('20 fotos: se dibujan las 20 tarjetas', grid.querySelectorAll('.photo').length === 20, grid.querySelectorAll('.photo').length);
    check('20 fotos: no aparece el botón "Ver más fotos"', !t.d.querySelector('#evMoreBtn'));
  }

  console.log(`\nResultado: ${pass} pasaron, ${fail} fallaron.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
