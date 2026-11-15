'use strict';
// OnlyClick — frontend (español). Sin frameworks.
// La descarga es una URL de mismo origen: /api/photo?id=... con
// Content-Disposition: attachment. En Chrome Android eso dispara el
// gestor de descargas real. NO es un blob URL ni navigator.share.
let token = localStorage.getItem('onlyclick_token') || '';
let me = null;
let mode = 'login'; // login | register
let currentEvent = null;
let currentPhotos = [];
let lightboxPhoto = null;

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error del servidor.');
  return data;
}

function saveToken(t) { token = t || ''; if (t) localStorage.setItem('onlyclick_token', t); else localStorage.removeItem('onlyclick_token'); }

async function refreshAuth() {
  try {
    const s = await api('/api/auth-status');
    me = s.user;
    $('#photoTakenNote').textContent = s.photographerTaken ? 'La cuenta de fotógrafo ya está ocupada.' : 'Todavía no hay cuenta de fotógrafo: la primera que se cree será la única.';
    if (me) {
      $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
      $('#session').innerHTML = `<span>Hola, ${esc(me.name)} (${me.role === 'photographer' ? 'fotógrafo' : 'deportista'})</span> <button class="secondary" id="logoutBtn" style="width:auto">Cerrar sesión</button>`;
      $('#logoutBtn').onclick = () => { saveToken(''); me = null; location.reload(); };
      $('#navPhoto').style.display = me.role === 'photographer' ? '' : 'none';
    } else {
      $('#auth').classList.remove('hidden'); $('#app').classList.add('hidden');
      $('#session').innerHTML = '';
    }
  } catch (e) { $('#authMsg').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

// ---- Descarga real: un solo botón "Guardar" ----
// 1) Registra la descarga gratis (o compra) en el servidor.
// 2) Dispara un <a href="/api/photo?id=..."> de mismo origen con download.
//    En Chrome Android eso guarda el archivo en Descargas / galería.
async function savePhoto(photo, freeMode) {
  const btns = document.querySelectorAll(`[data-save="${photo.id}"]`);
  btns.forEach(b => { b.disabled = true; b.textContent = 'Guardando…'; });
  try {
    if (freeMode) await api('/api/claim', { method: 'POST', body: JSON.stringify({ photoIds: [photo.id] }) });
    else if (!photo.owned) {
      if (!confirm(`Esta foto cuesta $${photo.price || 0} MXN. ¿Confirmas la compra? (Pago simulado, sin cargo real)`)) return;
      await api('/api/purchase', { method: 'POST', body: JSON.stringify({ photoIds: [photo.id] }) });
    }
    const a = document.createElement('a');
    a.href = `/api/photo?id=${photo.id}`;
    a.download = `onlyclick-foto-${photo.id}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
    btns.forEach(b => { b.textContent = '✓ Guardar iniciada — busca la foto en Descargas'; });
    setTimeout(() => loadEventDetail(currentEvent), 1500);
  } catch (e) {
    alert('No se pudo guardar: ' + e.message);
    btns.forEach(b => { b.disabled = false; b.textContent = freeMode ? 'Guardar gratis' : 'Guardar'; });
  }
}

function photoCard(p, freeMode) {
  const bibs = (p.bibs || []).map(b => `<span class="badge">Dorsal ${esc(b)}</span>`).join('');
  return `<div class="photo">
    <img src="/api/photo?id=${p.id}&inline=1" alt="Foto dorsal ${(p.bibs || []).join(', ')}" data-open="${p.id}">
    <div class="meta">${bibs || '<span class="muted">Sin dorsal</span>'}
      ${freeMode ? '<span class="badge free">Gratis</span>' : `<span class="badge">$${p.price || 0} MXN</span>`}
      ${p.owned ? '<span class="badge owned">Tuya</span>' : ''}
      <button data-save="${p.id}">${freeMode ? 'Guardar gratis' : 'Guardar'}</button>
    </div></div>`;
}

function bindPhotos(photos, freeMode) {
  document.querySelectorAll('[data-save]').forEach(b => b.onclick = () => {
    const p = photos.find(x => x.id === Number(b.dataset.save)) || currentPhotos.find(x => x.id === Number(b.dataset.save));
    if (p) savePhoto(p, freeMode);
  });
  document.querySelectorAll('[data-open]').forEach(img => img.onclick = () => {
    const p = photos.find(x => x.id === Number(img.dataset.open));
    if (!p) return;
    lightboxPhoto = p;
    $('#lbImg').src = `/api/photo?id=${p.id}&inline=1`;
    $('#lbInfo').textContent = `Dorsal: ${(p.bibs || []).join(', ') || 'sin dorsal'} · ${freeMode ? 'Descarga gratis' : '$' + (p.price || 0) + ' MXN'}`;
    $('#lbSave').textContent = freeMode ? 'Guardar gratis' : 'Guardar';
    $('#lbSave').dataset.save = p.id;
    $('#lightbox').style.display = 'flex';
  });
}

async function searchBib() {
  const bib = $('#bibInput').value.trim();
  if (!bib) return;
  const box = $('#searchResults'); box.innerHTML = '<p>Buscando…</p>';
  try {
    const r = await api('/api/search?bib=' + encodeURIComponent(bib));
    currentPhotos = r.photos;
    box.innerHTML = r.photos.length
      ? `<p>${r.photos.length} foto(s) con el dorsal ${esc(bib)}:</p><div class="grid">${r.photos.map(p => photoCard(p, p.freeMode)).join('')}</div>`
      : `<p>No hay fotos con el dorsal ${esc(bib)} en ningún evento.</p>`;
    bindPhotos(r.photos, true);
    // Los botones de resultados mezclan eventos gratis/de pago: re-enlazar con su modo real
    r.photos.forEach(p => { const b = document.querySelector(`[data-save="${p.id}"]`); if (b) b.onclick = () => savePhoto(p, p.freeMode); });
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function loadEvents() {
  const r = await api('/api/events');
  $('#eventList').innerHTML = r.events.length ? r.events.map(e => `
    <div class="card" style="background:#12142a">
      <strong>${esc(e.name)}</strong> · ${esc(e.sport)} · ${esc(e.eventDate)} · ${esc(e.location)}<br>
      <span class="muted">${e.photoCount} foto(s) · ${e.freeMode ? 'Descarga gratis' : 'De pago'}</span><br>
      <button data-ev="${e.id}">Ver fotos</button>
    </div>`).join('') : '<p>No hay eventos todavía.</p>';
  document.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => loadEventDetail(Number(b.dataset.ev)));
}

async function loadEventDetail(eventId) {
  currentEvent = eventId;
  const r = await api('/api/event-get?eventId=' + eventId);
  currentPhotos = r.photos;
  $('#eventDetail').innerHTML = `
    <h3>${esc(r.event.name)}</h3>
    <p class="muted">${esc(r.event.sport)} · ${esc(r.event.eventDate)} · ${esc(r.event.location)} · ${r.event.freeMode ? 'Descarga gratis' : 'De pago'}</p>
    <div class="row"><input id="evBib" inputmode="numeric" placeholder="Buscar dorsal en este evento"><button id="evBibBtn">Buscar</button></div>
    <div class="grid" id="evGrid">${r.photos.map(p => photoCard(p, r.event.freeMode)).join('') || '<p>No hay fotos todavía.</p>'}</div>`;
  bindPhotos(r.photos, r.event.freeMode);
  $('#evBibBtn').onclick = async () => {
    const bib = $('#evBib').value.trim(); if (!bib) return;
    const s = await api('/api/search?bib=' + encodeURIComponent(bib) + '&eventId=' + eventId);
    currentPhotos = s.photos;
    $('#evGrid').innerHTML = s.photos.map(p => photoCard(p, r.event.freeMode)).join('') || '<p>No hay fotos con ese dorsal en este evento.</p>';
    bindPhotos(s.photos, r.event.freeMode);
  };
}

async function loadMyPhotos() {
  const r = await api('/api/my-photos');
  $('#myPhotosList').innerHTML = r.photos.length ? `<div class="grid">${r.photos.map(p => photoCard(p, true)).join('')}</div>` : '<p>Todavía no tienes fotos guardadas.</p>';
  bindPhotos(r.photos, true);
}

async function loadPhotographer() {
  const box = $('#photoPanel');
  if (!me || me.role !== 'photographer') { box.innerHTML = '<p>Solo la cuenta de fotógrafo ve este panel.</p>'; return; }
  const events = (await api('/api/events')).events;
  const sales = await api('/api/sales').catch(() => ({ sales: [], totalDownloads: 0, freeDownloads: 0, revenue: 0 }));
  box.innerHTML = `
    <h3>Crear evento</h3>
    <input id="evName" placeholder="Nombre del evento (ej. Ensenada medio)">
    <div class="row"><input id="evSport" placeholder="Deporte" value="Carrera"><input id="evDate" type="date"><input id="evPlace" placeholder="Lugar"></div>
    <button id="evCreate">Crear evento</button>
    <h3>Subir fotos</h3>
    <select id="upEvent">${events.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
    <input id="upFiles" type="file" accept="image/*" multiple>
    <input id="upBibs" placeholder="Dorsales de estas fotos, separados por coma (ej. 223, 426)">
    <input id="upPrice" type="number" placeholder="Precio por foto en MXN (0 si es gratis)" value="0">
    <button id="upBtn">Subir fotos</button>
    <p class="muted">Escribe el dorsal a mano al subir: la búsqueda usa ese número guardado.</p>
    <h3>Mis eventos</h3>
    ${events.map(e => `<p><strong>${esc(e.name)}</strong> — ${e.freeMode ? 'Gratis' : 'De pago'} <button data-free="${e.id}">${e.freeMode ? 'Cambiar a pago' : 'Cambiar a gratis'}</button></p>`).join('') || '<p>Sin eventos.</p>'}
    <h3>Descargas y ventas</h3>
    <p>Total descargas: ${sales.totalDownloads} · Gratis: ${sales.freeDownloads} · Ingresos simulados: $${sales.revenue} MXN</p>
    ${sales.sales.map(s => `<p class="muted">${esc(s.eventName)} · Dorsal ${esc((s.bibs || []).join(', '))} · ${esc(s.buyerName)} · $${s.amount}</p>`).join('')}`;
  $('#evCreate').onclick = async () => {
    try { await api('/api/event-create', { method: 'POST', body: JSON.stringify({ name: $('#evName').value, sport: $('#evSport').value, eventDate: $('#evDate').value, location: $('#evPlace').value }) }); alert('Evento creado.'); loadPhotographer(); loadEvents(); } catch (e) { alert(e.message); }
  };
  $('#upBtn').onclick = async () => {
    const files = $('#upFiles').files; if (!files.length) return alert('Elige al menos una foto.');
    const bibs = $('#upBibs').value.split(',').map(s => s.trim()).filter(Boolean);
    for (const f of files) {
      const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f); });
      await api('/api/photo-upload', { method: 'POST', body: JSON.stringify({ eventId: Number($('#upEvent').value), filename: f.name, mimeType: f.type || 'image/jpeg', dataBase64: b64, bibs, price: Number($('#upPrice').value || 0) }) });
    }
    alert(files.length + ' foto(s) subida(s).'); loadPhotographer();
  };
  document.querySelectorAll('[data-free]').forEach(b => b.onclick = async () => {
    const ev = events.find(e => e.id === Number(b.dataset.free));
    await api('/api/set-free-mode', { method: 'POST', body: JSON.stringify({ eventId: ev.id, freeMode: !ev.freeMode }) });
    loadPhotographer(); loadEvents();
  });
}

function showView(v) {
  ['search', 'events', 'myphotos', 'photographer'].forEach(x => $('#view-' + x).classList.toggle('hidden', x !== v));
  if (v === 'events') loadEvents();
  if (v === 'myphotos') loadMyPhotos();
  if (v === 'photographer') loadPhotographer();
}

document.querySelectorAll('nav button[data-view]').forEach(b => b.onclick = () => showView(b.dataset.view));
$('#bibSearch').onclick = searchBib;
$('#bibInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchBib(); });
$('#lbClose').onclick = () => { $('#lightbox').style.display = 'none'; };
$('#lbSave').onclick = () => { if (lightboxPhoto) savePhoto(lightboxPhoto, true); };
$('#authToggle').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; $('#authTitle').textContent = mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'; $('#authSubmit').textContent = mode === 'login' ? 'Entrar' : 'Crear mi cuenta'; };
$('#authSubmit').onclick = async () => {
  const body = { email: $('#authEmail').value, password: $('#authPass').value };
  try {
    let r;
    if (mode === 'register') { body.name = $('#authName').value; body.role = $('#authRole').value; r = await api('/api/auth-register', { method: 'POST', body: JSON.stringify(body) }); }
    else r = await api('/api/auth-login', { method: 'POST', body: JSON.stringify(body) });
    saveToken(r.token); await refreshAuth(); showView('search');
  } catch (e) { $('#authMsg').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
};

refreshAuth();
