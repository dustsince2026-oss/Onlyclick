'use strict';
// Prueba automática (smoke test) contra el servidor local.
// Uso: npm run dev   (en otra terminal)  y luego: npm test
// O: node server.js & node scripts/smoke-test.js
// Flujo: fotógrafo → evento → foto dorsal 223 → deportista →
// búsqueda 223 → Guardar (claim + descarga real de bytes).
const { spawn } = require('child_process');
const http = require('http');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
// PNG 1x1 rojo, como foto de prueba (base64 sin prefijo data:)
const TEST_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
}

async function req(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function main() {
  const server = spawn('node', ['server.js'], { cwd: __dirname + '/..', stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch (_) {} };
  try {
    // Esperar a que el servidor responda
    for (let i = 0; i < 30; i++) { try { await fetch(BASE + '/'); break; } catch (_) { await new Promise(r => setTimeout(r, 300)); } }

    // 1. Fotógrafo
    const reg = await req('/api/auth-register', { method: 'POST', body: { name: 'Orlan', email: 'foto@onlyclick.test', password: 'secreto123', role: 'photographer' } });
    check('registro fotógrafo', reg.status === 201 && reg.data.user.role === 'photographer', JSON.stringify(reg.data).slice(0, 120));
    const photoToken = reg.data.token;

    // 2. Segundo fotógrafo debe ser rechazado
    const reg2 = await req('/api/auth-register', { method: 'POST', body: { name: 'Otro', email: 'otro@onlyclick.test', password: 'secreto123', role: 'photographer' } });
    check('segundo fotógrafo rechazado', reg2.status === 403, `status=${reg2.status}`);

    // 3. Login con contraseña incorrecta debe fallar
    const badLogin = await req('/api/auth-login', { method: 'POST', body: { email: 'foto@onlyclick.test', password: 'mal' } });
    check('login con contraseña incorrecta rechazado', badLogin.status === 401, `status=${badLogin.status}`);

    // 4. Crear evento
    const ev = await req('/api/event-create', { method: 'POST', token: photoToken, body: { name: 'Ensenada medio', sport: 'Carrera', eventDate: '2026-11-10', location: 'Ensenada' } });
    check('crear evento (gratis por defecto)', ev.status === 201 && ev.data.event.freeMode === true, JSON.stringify(ev.data).slice(0, 120));
    const eventId = ev.data.event.id;

    // 5. Subir foto con dorsal 223
    const up = await req('/api/photo-upload', { method: 'POST', token: photoToken, body: { eventId, filename: 'foto-223.png', mimeType: 'image/png', dataBase64: TEST_PNG_B64, bibs: ['223'], price: 0 } });
    check('subir foto con dorsal 223', up.status === 201 && (up.data.photo.bibs || []).includes('223'), JSON.stringify(up.data).slice(0, 160));
    const photoId = up.data.photo.id;

    // 6. Deportista
    const ath = await req('/api/auth-register', { method: 'POST', body: { name: 'Corredor', email: 'corredor@onlyclick.test', password: 'secreto123', role: 'athlete' } });
    check('registro deportista', ath.status === 201 && ath.data.user.role === 'athlete');
    const athToken = ath.data.token;

    // 7. Deportista NO puede crear eventos
    const evAth = await req('/api/event-create', { method: 'POST', token: athToken, body: { name: 'Nope', sport: 'Carrera' } });
    check('deportista no puede crear eventos', evAth.status === 403, `status=${evAth.status}`);

    // 8. Buscar dorsal 223
    const s = await req(`/api/search?bib=223`);
    check('búsqueda dorsal 223 encuentra la foto', s.status === 200 && s.data.photos.length === 1 && s.data.photos[0].id === photoId, `fotos=${(s.data.photos || []).length}`);
    const s999 = await req('/api/search?bib=999');
    check('búsqueda dorsal 999 no encuentra nada', s999.status === 200 && s999.data.photos.length === 0);

    // 9. Guardar gratis (claim) + descarga real de bytes
    const claim = await req('/api/claim', { method: 'POST', token: athToken, body: { photoIds: [photoId] } });
    check('claim descarga gratis registrado', claim.status === 200 && claim.data.count === 1, JSON.stringify(claim.data));
    const dlRes = await fetch(BASE + `/api/photo?id=${photoId}`, { headers: { Authorization: 'Bearer ' + athToken } });
    const buf = Buffer.from(await dlRes.arrayBuffer());
    check('descarga devuelve bytes de la foto', dlRes.status === 200 && buf.length > 0, `bytes=${buf.length}`);
    check('descarga con Content-Disposition attachment (mismo origen)', String(dlRes.headers.get('content-disposition') || '').startsWith('attachment'), dlRes.headers.get('content-disposition') || '');
    check('descarga es el mismo PNG subido', buf.equals(Buffer.from(TEST_PNG_B64, 'base64')));

    // 10. Mis fotos y ventas
    const mine = await req('/api/my-photos', { token: athToken });
    check('foto aparece en Mis fotos del deportista', mine.status === 200 && mine.data.photos.length === 1 && mine.data.photos[0].id === photoId);
    const sales = await req('/api/sales', { token: photoToken });
    check('fotógrafo ve 1 descarga gratis en ventas', sales.status === 200 && sales.data.totalDownloads === 1 && sales.data.freeDownloads === 1, JSON.stringify(sales.data).slice(0, 120));

    // 11. Cambiar evento a pago y comprobar que la descarga exige compra
    const paid = await req('/api/set-free-mode', { method: 'POST', token: photoToken, body: { eventId, freeMode: false } });
    check('fotógrafo puede cambiar evento a pago', paid.status === 200 && paid.data.event.freeMode === false);
    const ath2 = await req('/api/auth-register', { method: 'POST', body: { name: 'Corredor2', email: 'corredor2@onlyclick.test', password: 'secreto123', role: 'athlete' } });
    const dlPaid = await fetch(BASE + `/api/photo?id=${photoId}`, { headers: { Authorization: 'Bearer ' + ath2.data.token } });
    check('descarga de foto de pago sin comprar es rechazada', dlPaid.status === 403, `status=${dlPaid.status}`);

    console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally { stop(); }
}

main().catch(e => { console.error('ERROR', e); process.exitCode = 1; });
