// Pruebas del filtro por dorsal y "Mostrar más" en Revisar dorsales (jsdom).
// Carga public/index.html + public/app.js como <script> clásico (igual
// que el navegador), con fetch simulado. Comprueba:
//  1) Al abrir, la lista muestra solo las primeras 100 fotos, con el
//     campo "Buscar dorsal", el botón "Mostrar más" y el contador.
//  2) El filtro por dorsal deja solo las filas cuyo dorsal contiene lo
//     escrito y esconde las demás; el contador dice cuántas coinciden.
//  3) "Mostrar más" carga las siguientes 100 filas (y luego el resto)
//     y desaparece al llegar al final; las filas nuevas tienen su
//     "Releer con IA" y su "Guardar" funcionando.
//  4) Filtro + "Mostrar más" juntos: cargar más con un filtro activo
//     mantiene el filtro y revela las coincidencias de las filas nuevas.
//  5) Al borrar el filtro vuelven todas las filas cargadas.
//  6) El botón "Leer dorsales en lote (IA)" sigue procesando TODAS las
//     fotos (también las de más allá de la fila 100) y no solo las
//     visibles; "Guardar" sigue guardando igual.
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

const OWNER = { id: 1, name: 'Ricardo Orlan López Velázquez', email: 'dust.since2026@gmail.com', role: 'photographer', isOwner: true, approved: true, displayName: 'Only Dust' };
const EVENTS = [{ id: 3, photographerId: 1, name: 'Triatlon/Duatlón TRIJEX', sport: 'Carrera', eventDate: '2026-11-15', location: 'Ensenada', freeMode: true, priceMxn: 20, photoCount: 250 }];
// 250 fotos (ids 1000-1249). Con dorsal: 1000-1003 (387), 1100-1102 (284),
// 1150 (125), 1200-1201 (380), 1249 (18). Las demás, sin dorsal.
const PHOTOS = [];
for (let i = 0; i < 250; i++) {
  const id = 1000 + i;
  let bibs = [];
  if (i >= 0 && i <= 3) bibs = ['387'];
  if (i === 100) bibs = ['11', '284', '50', '126'];
  if (i === 101 || i === 102) bibs = ['284', '126', '16'];
  if (i === 150) bibs = ['125', '290'];
  if (i === 200) bibs = ['392', '380', '360', '127'];
  if (i === 201) bibs = ['380', '360', '116', '378'];
  if (i === 249) bibs = ['390', '18', '260'];
  PHOTOS.push({ id, bibs });
}
const BY_ID = {};
PHOTOS.forEach(p => { BY_ID[p.id] = p; });

function makeMock(calls) {
  const routes = {
    '/api/auth-status': { user: OWNER },
    '/api/events': { events: EVENTS },
    '/api/sales': { sales: [], totalDownloads: 0, freeDownloads: 0, revenue: 0 },
    '/api/stats': { totals: { photoViews: 0, uniqueViewers: 0, eventViews: 0, totalDownloads: 0, freeDownloads: 0, revenue: 0 }, events: [], topPhotos: [], topBibs: [] },
    '/api/my-earnings': { totalSold: 0, clipFee: 0, orlanFee: 0, photographerShare: 0, pendingBalance: 0, paidShare: 0 },
    '/api/payouts-summary': { totals: { totalSold: 0, clipFee: 0, orlanFee: 0, photographerShare: 0, pendingBalance: 0 }, photographers: [] },
    '/api/payouts-history': { payouts: [] },
    '/api/list-photographers': { photographers: [{ id: 1, name: OWNER.name, email: OWNER.email, eventCount: 1, totalSold: 0, isOwner: true, approved: true, hasApplication: true }] },
    '/api/list-applications': { applications: [] },
  };
  return async (url, fetchOpts) => {
    const [p] = String(url).split('?');
    const body = fetchOpts && fetchOpts.body ? JSON.parse(fetchOpts.body) : {};
    if (p === '/api/event-get') return { ok: true, json: async () => ({ event: EVENTS[0], photos: PHOTOS.map(x => ({ ...x, bibs: [...x.bibs] })) }) };
    if (p === '/api/read-bib') {
      calls.readBib.push(body.photoId);
      const saved = BY_ID[body.photoId] ? BY_ID[body.photoId].bibs : [];
      return { ok: true, json: async () => ({ ok: true, bibs: [...saved] }) };
    }
    if (p === '/api/photo-update') { calls.updates.push(body); return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => (routes[p] || {}) };
  };
}

async function boot(calls) {
  const dom = new JSDOM(html, { url: 'https://onlyclick-zeta.vercel.app/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const d = window.document;
  window.fetch = makeMock(calls);
  window.URL.createObjectURL = () => 'blob:fake';
  window.URL.revokeObjectURL = () => {};
  window.open = () => null;
  window.confirm = () => true;
  window.alert = () => {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const s = d.createElement('script');
  s.textContent = appJs;
  d.body.appendChild(s);
  await sleep(400); // refreshAuth + loadHome del arranque
  await window.loadPhotographer();
  await sleep(50);
  const revBtn = d.querySelector('[data-rev="3"]');
  if (!revBtn) throw new Error('no hay botón Revisar dorsales');
  revBtn.click();
  await sleep(200);
  return { window, d };
}

function visibleBibIds(d) {
  return [...d.querySelectorAll('#revRows .row')]
    .filter(r => r.style.display !== 'none')
    .map(r => Number(r.querySelector('input[id^="revBib-"]').id.replace('revBib-', '')));
}

(async () => {
  // 1) Vista inicial: 100 filas, filtro, botón y contador.
  console.log('— vista inicial');
  let calls = { readBib: [], updates: [] };
  let { window, d } = await boot(calls);
  const filter = d.getElementById('revFilter');
  check('filtro: existe el campo #revFilter', !!filter);
  check('filtro: dice "Buscar dorsal"', filter && filter.placeholder === 'Buscar dorsal…', filter && filter.placeholder);
  check('filtro: es tipo search (no submit)', filter && filter.type === 'search', filter && filter.type);
  check('contador: "Mostrando 100 de 250 fotos — el lote procesa todas."', (d.getElementById('revCount') || {}).textContent === 'Mostrando 100 de 250 fotos — el lote procesa todas.', (d.getElementById('revCount') || {}).textContent);
  check('filas: al abrir hay 100', d.querySelectorAll('#revRows .row').length === 100, d.querySelectorAll('#revRows .row').length);
  check('filas: la foto 1100 (fila 101) aún no está en el DOM', !d.getElementById('revBib-1100'));
  check('filas: la foto 1000 trae su dorsal 387', (d.getElementById('revBib-1000') || {}).value === '387', (d.getElementById('revBib-1000') || {}).value);
  check('botón: existe "Mostrar más"', !!d.getElementById('revMore') && d.getElementById('revMore').textContent === 'Mostrar más');
  check('botón: existe "Leer dorsales en lote (IA)"', !!d.getElementById('batchRead'));

  function typeFilter(t) {
    filter.value = t;
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    return visibleBibIds(d);
  }

  // 2) Filtro por dorsal dentro de las primeras 100.
  console.log('— filtro');
  let vis = typeFilter('387');
  check('filtro "387": deja 4 filas visibles', vis.length === 4, vis);
  check('filtro "387": son las fotos 1000-1003', JSON.stringify(vis) === '[1000,1001,1002,1003]', vis);
  check('filtro "387": el contador dice 4 de 250', (d.getElementById('revCount') || {}).textContent === 'Filtro "387": 4 foto(s) de 250.', (d.getElementById('revCount') || {}).textContent);
  check('filtro "387": la fila 1000 sigue con su "Releer con IA"', !!d.querySelector('[data-reread="1000"]'));
  vis = typeFilter('zzzqqq');
  check('filtro sin coincidencias: 0 visibles', vis.length === 0, vis);
  check('filtro sin coincidencias: el contador dice 0', (d.getElementById('revCount') || {}).textContent === 'Filtro "zzzqqq": 0 foto(s) de 250.', (d.getElementById('revCount') || {}).textContent);

  // 3) Filtro + "Mostrar más": el 284 está más allá de la fila 100.
  console.log('— filtro + mostrar más');
  vis = typeFilter('284');
  check('filtro "284" antes de cargar más: 0 visibles (está más allá de la fila 100)', vis.length === 0, vis);
  d.getElementById('revMore').click();
  await sleep(100);
  check('mostrar más: ahora hay 200 filas en el DOM', d.querySelectorAll('#revRows .row').length === 200, d.querySelectorAll('#revRows .row').length);
  check('mostrar más: la foto 1100 ya está en el DOM', !!d.getElementById('revBib-1100'));
  check('mostrar más: el filtro "284" sigue puesto', filter.value === '284', filter.value);
  vis = visibleBibIds(d);
  check('filtro "284" tras cargar más: 3 visibles', vis.length === 3, vis);
  check('filtro "284" tras cargar más: son 1100, 1101 y 1102', JSON.stringify(vis) === '[1100,1101,1102]', vis);
  check('filtro "284" tras cargar más: el contador dice 3', (d.getElementById('revCount') || {}).textContent === 'Filtro "284": 3 foto(s) de 250.', (d.getElementById('revCount') || {}).textContent);
  check('mostrar más: el botón sigue (faltan 50)', !!d.getElementById('revMore'));
  d.getElementById('revMore').click();
  await sleep(100);
  check('mostrar más: ahora hay 250 filas en el DOM', d.querySelectorAll('#revRows .row').length === 250, d.querySelectorAll('#revRows .row').length);
  check('mostrar más: el botón desaparece al llegar al final', !d.getElementById('revMore'));
  vis = visibleBibIds(d);
  check('filtro "284" con todo cargado: sigue en 3 visibles', vis.length === 3, vis);
  vis = typeFilter('380');
  check('filtro "380": 2 visibles (1200 y 1201)', JSON.stringify(vis) === '[1200,1201]', vis);

  // 4) Al borrar el filtro vuelven todas las filas cargadas.
  console.log('— borrar el filtro');
  vis = typeFilter('');
  check('al borrar: 250 visibles', vis.length === 250, vis.length);
  check('al borrar: el contador vuelve a "Mostrando 250 de 250"', (d.getElementById('revCount') || {}).textContent === 'Mostrando 250 de 250 fotos — el lote procesa todas.', (d.getElementById('revCount') || {}).textContent);

  // 5) "Releer con IA" funciona en una fila revelada por "Mostrar más".
  console.log('— releer en fila cargada con mostrar más');
  calls.readBib = [];
  d.querySelector('[data-reread="1100"]').click();
  await sleep(150);
  check('releer 1100: llamó a read-bib con esa foto', calls.readBib.includes(1100), calls.readBib);
  check('releer 1100: el cuadro trae los dorsales leídos', (d.getElementById('revBib-1100') || {}).value === '11, 284, 50, 126', (d.getElementById('revBib-1100') || {}).value);
  check('releer 1100: queda marcado ✓ IA', (d.getElementById('revState-1100') || {}).textContent === '✓ IA', (d.getElementById('revState-1100') || {}).textContent);
  vis = typeFilter('284');
  check('releer 1100: el filtro "284" la sigue mostrando', vis.includes(1100), vis);

  // 6) "Guardar" sigue guardando igual, y el filtro lee el texto actual.
  console.log('— guardar');
  typeFilter('');
  d.getElementById('revBib-1000').value = '388';
  d.querySelector('[data-savebib="1000"]').click();
  await sleep(150);
  check('guardar 1000: llamó a photo-update con el dorsal editado', calls.updates.some(u => u.photoId === 1000 && JSON.stringify(u.bibs) === '["388"]'), calls.updates);
  check('guardar 1000: queda marcado ✓ guardado', (d.getElementById('revState-1000') || {}).textContent === '✓ guardado', (d.getElementById('revState-1000') || {}).textContent);
  vis = typeFilter('388');
  check('filtro "388": muestra la fila con el texto editado (sin guardar en el lote)', JSON.stringify(vis) === '[1000]', vis);

  // 7) El lote sigue procesando TODAS las fotos, no solo las visibles.
  console.log('— lote intacto');
  calls = { readBib: [], updates: [] };
  const t2 = await boot(calls);
  const d2 = t2.d;
  const batchBtn = d2.getElementById('batchRead');
  check('lote: existe el botón', !!batchBtn);
  batchBtn.click();
  let status = '';
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    status = (d2.getElementById('batchStatus') || {}).textContent || '';
    if (status.includes('Terminado:')) break;
  }
  check('lote: termina con resumen', status.includes('Terminado: 0 con dorsal, 239 sin dorsal claro, 0 con error.'), status);
  check('lote: leyó las 239 fotos sin dorsal', calls.readBib.length === 239, calls.readBib.length);
  check('lote: leyó fotos de más allá de la fila 100 (1151, 1248)', calls.readBib.includes(1151) && calls.readBib.includes(1248), calls.readBib.slice(-5));
  check('lote: no releyó las que ya tenían dorsal (1000, 1100)', !calls.readBib.includes(1000) && !calls.readBib.includes(1100), calls.readBib.filter(x => x === 1000 || x === 1100));
  check('lote: no guardó nada (la IA no vio dorsales)', calls.updates.length === 0, calls.updates);

  console.log(`\ntest-revisar-dorsales-filtro.test.js: ${pass} pasaron, ${fail} fallaron.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR DEL TEST:', e); process.exit(1); });
