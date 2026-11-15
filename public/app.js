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
// Navegación con la flecha de atrás del teléfono (historial del navegador)
let currentView = 'search';
let suppressPush = false;
let lightboxPushed = false;
let lastBackAtHome = 0;

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
    lightboxPushed = true;
    lastBackAtHome = 0;
    pushNav({ view: currentView, lightbox: p.id });
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
  document.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => loadEventDetail(Number(b.dataset.ev), true));
}

async function loadEventDetail(eventId, push) {
  currentEvent = eventId;
  if (push) pushNav({ view: 'events', event: eventId });
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
    <input id="upPrice" type="number" placeholder="Precio por foto en MXN (0 si es gratis)" value="0">
    <div id="upList"></div>
    <p id="upStatus" class="muted"></p>
    <button id="upBtn">Subir fotos</button>
    <p class="muted">Las fotos se suben sin leer el dorsal. Después usa "Leer dorsales en lote" en Revisar dorsales para leerlos con IA.</p>
    <h3>Mis eventos</h3>
    ${events.map(e => `<p><strong>${esc(e.name)}</strong> — ${e.freeMode ? 'Gratis' : 'De pago'} <button data-free="${e.id}">${e.freeMode ? 'Cambiar a pago' : 'Cambiar a gratis'}</button> <button data-rev="${e.id}">Revisar dorsales</button></p>`).join('') || '<p>Sin eventos.</p>'}
    <div id="revList"></div>
    <p class="muted">Revisar dorsales muestra las fotos ya subidas de un evento: corrige el número o vuelve a leerlo con IA sin volver a subir la foto.</p>
    <h3>Descargas y ventas</h3>
    <p>Total descargas: ${sales.totalDownloads} · Gratis: ${sales.freeDownloads} · Ingresos simulados: $${sales.revenue} MXN</p>
    ${sales.sales.map(s => `<p class="muted">${esc(s.eventName)} · Dorsal ${esc((s.bibs || []).join(', '))} · ${esc(s.buyerName)} · $${s.amount}</p>`).join('')}`;
  $('#evCreate').onclick = async () => {
    try { await api('/api/event-create', { method: 'POST', body: JSON.stringify({ name: $('#evName').value, sport: $('#evSport').value, eventDate: $('#evDate').value, location: $('#evPlace').value }) }); alert('Evento creado.'); loadPhotographer(); loadEvents(); } catch (e) { alert(e.message); }
  };
  // --- Lectura automática de dorsales ---
  // 1) Visión por IA (Gemini, gratis) en el servidor: lee el número como lo
  //    vería una persona. 2) Si no hay llave de IA o falla, OCR local mejorado
  //    en el teléfono. El número siempre queda editable antes de subir.
  let upRows = [];
  let ocrWorker = null;
  async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    if (typeof Tesseract === 'undefined') throw new Error('No se pudo cargar el lector de dorsales. Revisa tu conexión e inténtalo de nuevo.');
    ocrWorker = await Tesseract.createWorker('eng');
    await ocrWorker.setParameters({ tessedit_char_whitelist: '0123456789' });
    return ocrWorker;
  }
  function downscale(dataUrl, maxW) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, (maxW || 1200) / img.width);
        const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  // Prepara la foto para el OCR: gris, más contraste y blanco/negro.
  function preprocess(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxW = 2000; const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h); const px = d.data;
        for (let i = 0; i < px.length; i += 4) {
          const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          const v = (g - 128) * 1.8 + 128 > 150 ? 255 : 0;
          px[i] = px[i + 1] = px[i + 2] = v;
        }
        ctx.putImageData(d, 0, 0);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  // Elige el número más confiable: prefiere 2-4 dígitos; un solo dígito solo
  // si la confianza es muy alta (así un "90" no se convierte en "1").
  function pickBib(words) {
    const cands = [];
    for (const w of (words || [])) {
      const t = String(w.text || '').replace(/\D/g, '');
      const c = Number(w.confidence || 0);
      if (t.length >= 2 && t.length <= 4 && c >= 40) cands.push({ n: t, c });
      else if (t.length === 1 && c >= 85) cands.push({ n: t, c });
    }
    if (!cands.length) return '';
    const multi = cands.filter(x => x.n.length >= 2);
    const pool = multi.length ? multi : cands;
    pool.sort((a, b) => (b.c - a.c) || (b.n.length - a.n.length));
    return pool[0].n;
  }
  async function readBibWithOcr(worker, dataUrl) {
    const prepped = await preprocess(dataUrl);
    for (const psm of ['6', '11']) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(prepped);
      const got = pickBib(data.words);
      if (got) return got;
    }
    return '';
  }
  async function readBibAuto(dataUrl) {
    try {
      const small = await downscale(dataUrl, 1600);
      const r = await api('/api/read-bib', { method: 'POST', body: JSON.stringify({ dataBase64: small.split(',')[1], mimeType: 'image/jpeg' }) });
      if (r && r.ok) {
        const list = Array.isArray(r.bibs) ? r.bibs : (r.bib ? [r.bib] : []);
        const joined = list.join(', ');
        return { bib: joined, source: joined ? 'ia' : 'ia-none' };
      }
    } catch (_) { /* sin IA: cae al OCR local */ }
    try {
      const worker = await getOcrWorker();
      const got = await readBibWithOcr(worker, dataUrl);
      return { bib: got, source: got ? 'ocr' : 'none' };
    } catch (_) { return { bib: '', source: 'none' }; }
  }
  function renderUpList() {
    $('#upList').innerHTML = upRows.map((row, i) => `
      <div class="row" style="align-items:center">
        <span class="muted" style="flex:1;min-width:120px">${esc(row.file.name)}</span>
        <input id="upBib-${i}" inputmode="numeric" placeholder="Dorsal" value="${esc(row.bibs)}" style="max-width:130px">
        <span id="upState-${i}" class="muted"></span>
      </div>`).join('');
    document.querySelectorAll('#upList input[id^="upBib-"]').forEach(inp => inp.oninput = () => { upRows[Number(inp.id.split('-')[1])].bibs = inp.value; });
  }
  $('#upFiles').onchange = async () => {
    const files = [...$('#upFiles').files];
    upRows = files.map(f => ({ file: f, bibs: '', status: '' }));
    renderUpList();
    if (!files.length) return;
    $('#upStatus').textContent = 'Sin leer todavía — súbelas y luego usa "Leer dorsales en lote" en Revisar dorsales.';
    return;
    
  // Pequeño pool de concurrencia: sube/lee de 3 en 3 para que sea rápido
  // sin saturar la conexión ni la llave de IA.
  async function runPool(items, n, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const item = items[i++]; await fn(item); }
    });
    await Promise.all(workers);
  }
  $('#upBtn').onclick = async () => {
    const files = upRows.length ? upRows : [...$('#upFiles').files].map(f => ({ file: f, bibs: '' }));
    if (!files.length) return alert('Elige al menos una foto.');
    const eventId = Number($('#upEvent').value);
    if (!eventId) return alert('Primero crea un evento.');
    let n = 0, fails = 0;
    await runPool(files, 3, async (row) => {
      try {
        const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(row.file); });
        // Se comprime a 1600px antes de subir: pesa mucho menos, sube más
        // rápido y ocupa menos espacio en Supabase.
        const small = await downscale(dataUrl, 1600);
        const b64 = small.split(',')[1];
        const bibs = String(row.bibs || '').split(',').map(s => s.trim()).filter(Boolean);
        await api('/api/photo-upload', { method: 'POST', body: JSON.stringify({ eventId, filename: row.file.name, mimeType: 'image/jpeg', dataBase64: b64, bibs, price: Number($('#upPrice').value || 0) }) });
        n++;
      } catch (_) { fails++; }
      $('#upStatus').textContent = 'Subiendo… ' + (n + fails) + '/' + files.length + (fails ? ' · ' + fails + ' fallaron' : '');
    });
    alert(n + ' foto(s) subida(s).' + (fails ? ' ' + fails + ' fallaron, inténtalas de nuevo.' : '')); loadPhotographer();
  };
  document.querySelectorAll('[data-free]').forEach(b => b.onclick = async () => {
    const ev = events.find(e => e.id === Number(b.dataset.free));
    await api('/api/set-free-mode', { method: 'POST', body: JSON.stringify({ eventId: ev.id, freeMode: !ev.freeMode }) });
    loadPhotographer(); loadEvents();
  });
  document.querySelectorAll('[data-rev]').forEach(b => b.onclick = async () => {
    const ev = events.find(e => e.id === Number(b.dataset.rev));
    const box = $('#revList');
    box.innerHTML = '<p class="muted">Cargando fotos…</p>';
    try {
      const r = await api('/api/event-get?eventId=' + ev.id);
      box.innerHTML = '<h4>' + esc(r.event.name) + ' — ' + r.photos.length + ' foto(s)</h4><button id="batchRead">Leer dorsales en lote (IA)</button> <span id="batchStatus" class="muted"></span>' + (r.photos.length > 100 ? '<p class="muted">Mostrando 100 de ' + r.photos.length + ' fotos — el lote procesa todas.</p>' : '') + r.photos.slice(0, 100).map(p => `
        <div class="row" style="align-items:center">
          <img src="/api/photo?id=${p.id}&inline=1" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px">
          <input id="revBib-${p.id}" inputmode="numeric" placeholder="Dorsal" value="${esc((p.bibs || []).join(', '))}" style="max-width:130px">
          <button data-reread="${p.id}">Releer con IA</button>
          <button data-savebib="${p.id}">Guardar</button>
          <span id="revState-${p.id}" class="muted"></span>
        </div>`).join('');
      // Lote: lee con IA solo las fotos sin dorsal, de 3 en 3, y guarda cada
      // una en cuanto queda. Si se cierra la página, lo ya guardado queda y
      // al darle otra vez continúa con las que faltan.
      const batchBtn = document.getElementById('batchRead');
      if (batchBtn) batchBtn.onclick = async () => {
        const targets = (r.photos || []).filter(p => !(p.bibs || []).length);
        if (!targets.length) { document.getElementById('batchStatus').textContent = 'Todas las fotos ya tienen dorsal.'; return; }
        batchBtn.disabled = true;
        let done = 0, ok = 0, none = 0, err = 0;
        const bStatus = () => { const el = document.getElementById('batchStatus'); if (el) el.textContent = 'Leyendo… ' + done + '/' + targets.length + ' · ✓ ' + ok + ' · sin dorsal ' + none + ' · errores ' + err; };
        bStatus();
        await runPool(targets, 3, async (p) => {
          const st = document.getElementById('revState-' + p.id);
          try {
            const r2 = await api('/api/read-bib', { method: 'POST', body: JSON.stringify({ photoId: p.id }) });
            const list = Array.isArray(r2.bibs) ? r2.bibs : (r2.bib ? [r2.bib] : []);
            if (r2.ok && list.length) {
              await api('/api/photo-update', { method: 'POST', body: JSON.stringify({ photoId: p.id, bibs: list }) });
              const inp = document.getElementById('revBib-' + p.id); if (inp) inp.value = list.join(', ');
              if (st) st.textContent = '✓ IA'; ok++;
            } else if (r2.ok) { if (st) st.textContent = 'Sin dorsal claro'; none++; }
            else { if (st) st.textContent = 'La IA falló' + (r2.status ? ' (error ' + r2.status + ')' : ''); err++; }
          } catch (e) { if (st) st.textContent = e.message || 'No se pudo releer'; err++; }
          done++; bStatus();
        });
        batchBtn.disabled = false;
        const el = document.getElementById('batchStatus'); if (el) el.textContent = 'Terminado: ' + ok + ' con dorsal, ' + none + ' sin dorsal claro, ' + err + ' con error. Si quedaron con error, dale otra vez al botón.';
      };
      box.querySelectorAll('[data-reread]').forEach(rb => rb.onclick = async () => {
        const id = Number(rb.dataset.reread);
        const st = document.getElementById('revState-' + id); if (st) st.textContent = 'Leyendo…';
        try {
          const r2 = await api('/api/read-bib', { method: 'POST', body: JSON.stringify({ photoId: id }) });
          const list = Array.isArray(r2.bibs) ? r2.bibs : (r2.bib ? [r2.bib] : []);
          if (r2.ok && list.length) { document.getElementById('revBib-' + id).value = list.join(', '); if (st) st.textContent = '✓ IA'; }
          else if (r2.ok) { if (st) st.textContent = 'La IA no vio dorsal claro'; }
          else if (r2.reason === 'no-key') { if (st) st.textContent = 'Sin llave de IA todavía'; }
          else if (st) st.textContent = 'La IA falló' + (r2.status ? ' (error ' + r2.status + ')' : '') + (r2.detail ? ': ' + r2.detail : '');
        } catch (e) { if (st) st.textContent = e.message || 'No se pudo releer'; }
      });
      box.querySelectorAll('[data-savebib]').forEach(sb => sb.onclick = async () => {
        const id = Number(sb.dataset.savebib);
        const bibs = document.getElementById('revBib-' + id).value.split(',').map(s => s.trim()).filter(Boolean);
        await api('/api/photo-update', { method: 'POST', body: JSON.stringify({ photoId: id, bibs }) });
        const st = document.getElementById('revState-' + id); if (st) st.textContent = '✓ guardado';
      });
    } catch (e) { box.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
  });
}

function showView(v) {
  ['search', 'events', 'myphotos', 'photographer'].forEach(x => $('#view-' + x).classList.toggle('hidden', x !== v));
  if (v !== currentView) { currentView = v; lastBackAtHome = 0; pushNav({ view: v }); }
  if (v === 'events') loadEvents();
  if (v === 'myphotos') loadMyPhotos();
  if (v === 'photographer') loadPhotographer();
}

// ---- Botón atrás del teléfono ----
// Cada vista y cada foto ampliada deja un paso en el historial del
// navegador, así la flecha de atrás regresa dentro de la app (cierra la
// foto, vuelve a la lista de eventos, cambia de vista) en vez de sacarte
// de la página. Desde el inicio, la primera vez avisa y la segunda
// seguida sí sale.
function pushNav(state) {
  if (suppressPush) return;
  try { history.pushState(state, ''); } catch (_) {}
}
function hideLightbox() {
  $('#lightbox').style.display = 'none';
  lightboxPhoto = null;
  lightboxPushed = false;
}
function closeLightbox() {
  if (lightboxPushed) { history.back(); return; }
  hideLightbox();
}
function atHome() {
  return currentView === 'search' && !lightboxPhoto && !(($('#eventDetail').innerHTML || '').trim());
}
function showExitToast() {
  const t = document.createElement('div');
  t.textContent = 'Pulsa atrás otra vez para salir de OnlyClick';
  t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#2c3157;color:#fff;padding:10px 16px;border-radius:8px;z-index:99;font-size:15px';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
function guardHomeExit() {
  lastBackAtHome = Date.now();
  try { history.pushState({ view: 'search', homeGuard: true }, ''); } catch (_) {}
  showExitToast();
}
function applyNavState(st) {
  // Muestra la vista del estado sin empujar otro paso al historial.
  suppressPush = true;
  try {
    if (lightboxPhoto) hideLightbox();
    if (st && st.event) { showView('events'); loadEventDetail(st.event); }
    else if (st && st.view) {
      if (st.view === 'events') $('#eventDetail').innerHTML = '';
      showView(st.view);
    } else { showView('search'); }
  } finally { suppressPush = false; }
}
window.addEventListener('popstate', (e) => {
  const st = e.state;
  if (!st) {
    if (atHome()) {
      if (Date.now() - lastBackAtHome < 2500) return; // segunda vez: salir
      guardHomeExit();
      return;
    }
    applyNavState({ view: 'search' });
    return;
  }
  if (st.homeGuard) {
    if (atHome()) {
      if (Date.now() - lastBackAtHome < 2500) { try { history.go(-2); } catch (_) {} return; }
      guardHomeExit();
      return;
    }
    applyNavState(st);
    return;
  }
  applyNavState(st);
});

document.querySelectorAll('nav button[data-view]').forEach(b => b.onclick = () => showView(b.dataset.view));
$('#bibSearch').onclick = searchBib;
$('#bibInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchBib(); });
$('#lbClose').onclick = () => closeLightbox();
$('#lbSave').onclick = () => { if (lightboxPhoto) savePhoto(lightboxPhoto, true); };
$('#authToggle').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; $('#authTitle').textContent = mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'; $('#authSubmit').textContent = mode === 'login' ? 'Entrar' : 'Crear mi cuenta'; $('#authToggle').textContent = mode === 'login' ? '¿No tienes cuenta? Crear cuenta' : '¿Ya tienes cuenta? Iniciar sesión'; $('#authName').style.display = mode === 'register' ? '' : 'none'; $('#authRole').style.display = mode === 'register' ? '' : 'none'; };
$('#authSubmit').onclick = async () => {
  const body = { email: $('#authEmail').value, password: $('#authPass').value };
  try {
    let r;
    if (mode === 'register') { body.name = $('#authName').value; body.role = $('#authRole').value; r = await api('/api/auth-register', { method: 'POST', body: JSON.stringify(body) }); }
    else r = await api('/api/auth-login', { method: 'POST', body: JSON.stringify(body) });
    saveToken(r.token); await refreshAuth(); showView('search');
  } catch (e) { $('#authMsg').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
};

// Estado inicial en el historial para que la primera flecha de atrás no
// saque de la app.
try { history.replaceState({ view: 'search' }, ''); } catch (_) {}

refreshAuth();
