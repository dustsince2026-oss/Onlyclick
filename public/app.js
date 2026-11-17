'use strict';
// OnlyClick — frontend (español). Sin frameworks.
// La descarga es una URL de mismo origen: /api/photo?id=... con
// Content-Disposition: attachment. En Chrome Android eso dispara el
// gestor de descargas real. NO es un blob URL ni navigator.share.
let token = localStorage.getItem('onlyclick_token') || '';
let me = null;
let mode = 'login'; // login | register
let resetToken = ''; // ?reset=... del enlace que llega por correo
let inviteToken = ''; // ?invite=... del link de invitación aprobado
let currentEvent = null;
let currentTipClabe = '';
let currentTipName = '';
let currentPhotos = [];
let lightboxPhoto = null;
let lightboxFreeMode = true;
let lightboxPriceMxn = 0;
// Navegación con la flecha de atrás del teléfono (historial del navegador)
let currentView = 'home';
let suppressPush = false;
let lightboxPushed = false;
let lastBackAtHome = 0;
let forceResetView = false; // ?reset=... : mostrar el form de nueva contraseña aunque haya sesión

// ---- Pestañas y paginación del panel del fotógrafo ----
// El panel se divide en pestañas (Ventas, Estadísticas, Fotógrafos /
// Mis ganancias, Gestión) para que no sea un scroll infinito, y cada
// lista larga muestra 10 renglones por página con botones de página.
// Solo cambia cómo se MUESTRA lo ya cargado: no toca qué datos se piden
// ni los totales. Al recargar el panel (loadPhotographer) las listas
// vuelven a la página 1; la pestaña activa sí se recuerda mientras se
// navega por el panel.
const PANEL_PAGE_SIZE = 10;
let panelTab = 'ventas'; // pestaña activa del panel
let panelPages = {}; // clave de lista -> página actual (empieza en 1)

// Muestra solo la pestaña pedida del panel; las demás se esconden.
function showPanelTab(tab) {
  panelTab = tab;
  document.querySelectorAll('#photoPanel [data-tabpanel]').forEach(s => s.classList.toggle('hidden', s.dataset.tabpanel !== tab));
  document.querySelectorAll('#photoPanel [data-panel-tabbtn]').forEach(b => b.classList.toggle('primary', b.dataset.panelTabbtn === tab));
}

// Botones rápidos del panel: cambia a la pestaña y baja a la sección
// pedida (si la hay). El scroll se protege por si el entorno no lo
// tiene (p. ej. pruebas con jsdom).
// Navegador dentro de Facebook/Instagram: las descargas con blob no
// funcionan ahí (se quedan en "Descargando"). Se avisa con un banner y
// se ofrece abrir la foto en una pestaña nueva.
function isInAppBrowser() { return /FBAN|FBAV|FB_IAB|Instagram/i.test(navigator.userAgent || ''); }

// Botón "Abrir en Chrome" del banner: abrir esta misma página en el
// navegador. Android: intent:// con package=com.android.chrome;
// iPhone: esquema googlechrome:// (abre Chrome si está instalado).
function openInBrowser() {
  const u = location.href.replace(/^https?:\/\//, '');
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) window.open('googlechrome://' + u, '_blank');
  else if (/Android/i.test(ua)) window.open('intent://' + u + '#Intent;scheme=https;package=com.android.chrome;end', '_blank');
  else window.open(location.href, '_blank');
}
function goPanelSection(tab, secId) {
  showPanelTab(tab);
  if (!secId) return;
  var el = document.getElementById(secId);
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Dibuja los botones de página (‹ Anterior, números, Siguiente › y
// "Página X de Y") debajo de una lista. Si hay más de 7 páginas se
// muestran la primera, la última y las cercanas a la actual, con "…" en
// medio, para que los botones no se alarguen tampoco.
function renderPagerControls(key, totalPages, page) {
  const box = document.querySelector(`#photoPanel [data-pg-controls="${key}"]`);
  if (!box) return;
  if (totalPages <= 1) { box.innerHTML = ''; return; }
  const nums = [];
  for (let p = 1; p <= totalPages; p++) {
    if (totalPages <= 7 || p === 1 || p === totalPages || Math.abs(p - page) <= 1) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  box.innerHTML = `<p class="muted" style="margin:8px 0 0">Página ${page} de ${totalPages} · <button data-pg-goto="${key}|${page - 1}" ${page <= 1 ? 'disabled' : ''} style="padding:6px 10px;font-size:14px">‹ Anterior</button> ` +
    nums.map(n => n === '…' ? '<span class="muted">…</span> ' : `<button data-pg-goto="${key}|${n}" class="${n === page ? 'primary' : ''}" style="padding:6px 10px;font-size:14px">${n}</button> `).join('') +
    `<button data-pg-goto="${key}|${page + 1}" ${page >= totalPages ? 'disabled' : ''} style="padding:6px 10px;font-size:14px">Siguiente ›</button></p>`;
}

// Aplica la paginación a todas las listas del panel ([data-pg]): muestra
// solo los 10 renglones de la página actual y dibuja sus controles.
function applyPanelPagination() {
  document.querySelectorAll('#photoPanel [data-pg]').forEach(list => {
    const key = list.dataset.pg;
    const items = Array.from(list.children);
    const totalPages = Math.max(1, Math.ceil(items.length / PANEL_PAGE_SIZE));
    let page = panelPages[key] || 1;
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    panelPages[key] = page;
    items.forEach((it, i) => { it.style.display = (i >= (page - 1) * PANEL_PAGE_SIZE && i < page * PANEL_PAGE_SIZE) ? '' : 'none'; });
    renderPagerControls(key, totalPages, page);
  });
}

// Pestañas y paginación del panel: un solo listener delegado en el panel
// (sobrevive a los re-renders de loadPhotographer, así que se liga una
// sola vez al cargar la página).
(function () {
  const panel = document.getElementById('photoPanel');
  if (!panel) return;
  panel.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-panel-tabbtn]');
    if (tabBtn) { showPanelTab(tabBtn.dataset.panelTabbtn); return; }
    const pgBtn = e.target.closest('[data-pg-goto]');
    if (pgBtn && !pgBtn.disabled) {
      const parts = pgBtn.dataset.pgGoto.split('|');
      panelPages[parts[0]] = Number(parts[1]);
      applyPanelPagination();
    }
  });
})();

// ---- Carrito con descuentos por volumen ----
// Regla FINAL (decisión del dueño 2026-11-16): los paquetes son APARTE.
// Fotos INDIVIDUALES: 1-3 a precio normal, 4a y 5a con 20% de descuento
// cada una, 6a en adelante a precio NORMAL (sin descuento).
// PAQUETES: el carrito forma AUTOMÁTICAMENTE floor(N/10) paquetes de 10
// fotos; cada paquete cuesta 25% menos que el total de sus 10 fotos.
// NINGÚN precio está fijo en el código: todos salen de priceMxn (el
// precio por foto del evento, editable en "Mis eventos"), así los
// porcentajes sirven con cualquier precio.
// Regla de orden (igual en el servidor): precio descendente, luego id asc.
// Para cambiar los porcentajes o el tamaño del paquete se toca SOLO este
// bloque aquí y su gemelo en api/_lib/handlers.js. El servidor SIEMPRE
// cobra lo que calcula su propia cartTotals, así que lo que se muestra
// aquí y lo que se cobra es lo mismo mientras las dos copias digan lo mismo.
const PACKAGE_SIZE = 10;
const PACKAGE_DISCOUNT = 0.25;
const SINGLE_TIERS = [
  { from: 1, to: 3, discount: 0 },
  { from: 4, to: 5, discount: 0.20 },
  { from: 6, to: Infinity, discount: 0 },
];
const CART_MAX_TOTAL = 5000; // límite de Clip por transacción (MXN)
const CART_KEY = 'onlyclick_cart';
let cart = loadCart();
function loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(x => x && Number(x.id)) : [];
  } catch (_) { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (_) {}
  updateCartFab();
}
function singleDiscountForPosition(pos) {
  for (const t of SINGLE_TIERS) if (pos >= t.from && pos <= t.to) return t.discount;
  return 0;
}
// Reparte `total` en n partes enteras que suman exactamente total.
function splitAmount(total, n) {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(base + (i < rem ? 1 : 0));
  return out;
}
// items: [{ id, priceMxn }] — misma fórmula que api/_lib/handlers.js.
function cartTotals(items) {
  const sorted = items.slice().sort((a, b) => (Number(b.priceMxn || b.price || 0) - Number(a.priceMxn || a.price || 0)) || (Number(a.id) - Number(b.id)));
  const numPackages = Math.floor(sorted.length / PACKAGE_SIZE);
  const packages = [];
  for (let p = 0; p < numPackages; p++) {
    const group = sorted.slice(p * PACKAGE_SIZE, p * PACKAGE_SIZE + PACKAGE_SIZE);
    const subtotal = group.reduce((s, it) => s + Math.round(Number(it.priceMxn || it.price || 0) * 100) / 100, 0);
    const total = Math.round(subtotal * (1 - PACKAGE_DISCOUNT));
    packages.push({ photoIds: group.map(g => g.id), subtotal, discount: subtotal - total, total, amounts: splitAmount(total, group.length) });
  }
  const singles = sorted.slice(numPackages * PACKAGE_SIZE);
  const lines = singles.map((it, i) => {
    const price = Math.round(Number(it.priceMxn || it.price || 0) * 100) / 100;
    const discount = singleDiscountForPosition(i + 1);
    return { id: it.id, price, discount, lineTotal: Math.round(price * (1 - discount)) };
  });
  const subtotal = packages.reduce((s, p) => s + p.subtotal, 0) + lines.reduce((s, l) => s + l.price, 0);
  const total = packages.reduce((s, p) => s + p.total, 0) + lines.reduce((s, l) => s + l.lineTotal, 0);
  return { packages, lines, subtotal, discount: subtotal - total, total };
}
// Precio del paquete de 10 si el carrito (6-9 fotos) llegara a 10: se
// supone que las fotos que faltan son del mismo precio que la más cara
// del carrito (lo normal: mismo evento). Nunca un número fijo.
function packageUpsell() {
  if (cart.length < 6 || cart.length >= PACKAGE_SIZE) return null;
  const missing = PACKAGE_SIZE - cart.length;
  const maxPrice = Math.max(...cart.map(x => Number(x.priceMxn || x.price || 0)));
  const currentSum = cart.reduce((s, x) => s + Math.round(Number(x.priceMxn || x.price || 0) * 100) / 100, 0);
  const packageTotal = Math.round((currentSum + missing * maxPrice) * (1 - PACKAGE_DISCOUNT));
  return { missing, packageTotal };
}
function cartHas(id) { return cart.some(x => x.id === Number(id)); }
function updateCartFab() {
  const fab = $('#cartFab'), badge = $('#cartCount');
  if (!fab || !badge) return;
  badge.textContent = String(cart.length);
  badge.classList.toggle('hidden', cart.length === 0);
}
// Aviso corto abajo en pantalla (como el de "pulsa atrás otra vez").
function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#26262c;color:#fff;padding:10px 16px;border-radius:8px;z-index:99;font-size:15px';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
function addToCart(photo) {
  const freeMode = photo.freeMode !== false;
  if (freeMode || photo.owned) return;
  if (cartHas(photo.id)) { showView('cart'); return; } // ya está: ir al carrito
  cart.push({ id: photo.id, eventId: photo.eventId, eventName: photo.eventName || '', priceMxn: Number(photo.priceMxn || photo.price || 0), bibs: (photo.bibs || []).slice() });
  saveCart();
  document.querySelectorAll(`[data-cart="${photo.id}"]`).forEach(b => { b.textContent = 'En el carrito ✓'; b.disabled = true; });
  const lb = $('#lbCart');
  if (lb && Number(lb.dataset.cart) === photo.id) { lb.textContent = 'En el carrito ✓'; lb.disabled = true; }
  showToast('Foto agregada al carrito (' + cart.length + ').');
}
function removeFromCart(id) {
  cart = cart.filter(x => x.id !== Number(id));
  saveCart();
  document.querySelectorAll(`[data-cart="${id}"]`).forEach(b => { b.textContent = 'Agregar al carrito'; b.disabled = false; });
  const lb = $('#lbCart');
  if (lb && Number(lb.dataset.cart) === Number(id)) { lb.textContent = 'Agregar al carrito'; lb.disabled = false; }
}
function clearCart() { cart = []; saveCart(); }

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

// Pequeño pool de concurrencia: sube/lee de 3 en 3 para que sea rápido
// sin saturar la conexión ni la llave de IA.
async function runPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

// Lee con IA los dorsales de las fotos que no tienen, de 3 en 3, y guarda
// cada una en cuanto queda. onProgress(done,total,ok,none,err) se llama
// con el avance; onPhoto(p, res, list, errText) por cada foto ('ok' /
// 'none' / 'err'). Si se cierra la página, lo ya guardado queda y al
// darle otra vez continúa con las que faltan. Devuelve el resumen.
async function batchReadBibs(photos, onProgress, onPhoto) {
  const targets = (photos || []).filter(p => !(p.bibs || []).length);
  let done = 0, ok = 0, none = 0, err = 0;
  const report = () => { if (onProgress) onProgress(done, targets.length, ok, none, err); };
  report();
  await runPool(targets, 3, async (p) => {
    let res = 'err', list = [], errText = '';
    try {
      const r2 = await api('/api/read-bib', { method: 'POST', body: JSON.stringify({ photoId: p.id }) });
      list = Array.isArray(r2.bibs) ? r2.bibs : (r2.bib ? [r2.bib] : []);
      if (r2.ok && list.length) {
        await api('/api/photo-update', { method: 'POST', body: JSON.stringify({ photoId: p.id, bibs: list }) });
        res = 'ok'; ok++;
      } else if (r2.ok) { res = 'none'; none++; }
      else { errText = 'La IA falló' + (r2.status ? ' (error ' + r2.status + ')' : ''); err++; }
    } catch (e) { errText = e.message || 'No se pudo releer'; err++; }
    if (onPhoto) onPhoto(p, res, list, errText);
    done++; report();
  });
  return { total: targets.length, ok, none, err };
}

// Al terminar una subida, lee los dorsales sola, en segundo plano.
// Busca el renglón de estado cada vez porque el panel se vuelve a
// dibujar al terminar la subida; si el fotógrafo ya se fue de la
// vista, la lectura sigue igual y lo guardado queda.
async function autoReadBibsAfterUpload(eventId) {
  const upStatus = () => document.getElementById('upStatus');
  try {
    const r = await api('/api/event-get?eventId=' + eventId);
    const res = await batchReadBibs(r.photos || [], (done, total, ok, none, err) => {
      const el = upStatus(); if (el) el.textContent = 'Leyendo dorsales… ' + done + '/' + total + ' · ✓ ' + ok + ' · sin dorsal ' + none + ' · errores ' + err;
    });
    const el = upStatus();
    if (el) el.textContent = res.total ? ('Dorsales listos: ' + res.ok + ' con dorsal, ' + res.none + ' sin dorsal claro, ' + res.err + ' con error.') : 'Todas las fotos ya tenían dorsal.';
  } catch (e) {
    const el = upStatus(); if (el) el.textContent = 'No se pudieron leer los dorsales solos; usa "Leer dorsales en lote" en Revisar dorsales.';
  }
}

function saveToken(t) { token = t || ''; if (t) localStorage.setItem('onlyclick_token', t); else localStorage.removeItem('onlyclick_token'); }

// Visitante anónimo para estadísticas: un código por navegador, creado
// una sola vez. No es un nombre ni un correo: solo sirve para contar
// cuántas personas diferentes vieron las fotos.
function getVisitorKey() {
  try {
    let id = localStorage.getItem('onlyclick_vid');
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : ('v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
      localStorage.setItem('onlyclick_vid', id);
    }
    return 'v:' + id;
  } catch (_) { return 'anon'; }
}
// Registro de vistas (fotos/eventos/búsquedas): nunca bloquea ni rompe
// nada — si falla, se ignora en silencio. En una sesión no se reenvía
// la misma vista dos veces; el servidor además cuenta 1 por visitante
// por foto / evento / dorsal por día.
const _viewedThisSession = new Set();
function trackView(kind, photoId, eventId, bib) {
  try {
    const key = [kind, photoId || '', eventId || '', bib || ''].join('|');
    if (_viewedThisSession.has(key)) return;
    _viewedThisSession.add(key);
    api('/api/track-view', { method: 'POST', body: JSON.stringify({ kind, photoId: photoId || null, eventId: eventId || null, bib: bib || '', viewerKey: getVisitorKey() }) }).catch(() => {});
  } catch (_) {}
}

async function refreshAuth() {
  try {
    const s = await api('/api/auth-status');
    me = s.user;
    $('#photoTakenNote').textContent = 'Si te registras como fotógrafo, ONLYCLICK debe aprobar tu cuenta antes de que puedas crear eventos.';
    const sessionEl = $('#session');
    if (me && !forceResetView) {
      $('#auth').classList.add('hidden');
      $('#profileBlock').classList.remove('hidden');
      $('#profileTitle').textContent = 'Hola, ' + me.name;
      $('#profileInfo').textContent = me.email + ' · ' + (me.role === 'photographer' ? 'Fotógrafo' : 'Deportista');
      $('#view-photographer').style.display = me.role === 'photographer' ? '' : 'none';
      const initials = me.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'OC';
      sessionEl.innerHTML = `<button id="avatarBtn" class="avatar" aria-label="Mi cuenta">${esc(initials)}</button>`;
      renderUserMenu();
      $('#avatarBtn').onclick = (e) => { e.stopPropagation(); $('#userMenu').classList.toggle('hidden'); };
      const pl = $('#profileLogout');
      if (pl) pl.onclick = doLogout;
      updateNotificationsNav();
      refreshNotifBadge();
    } else {
      updateNotificationsNav();
      updateNotifBadge(0);
      $('#auth').classList.remove('hidden');
      $('#profileBlock').classList.add('hidden');
      sessionEl.innerHTML = `<button id="loginBtn" class="ghost">Entrar</button>`;
      $('#loginBtn').onclick = () => showView('account');
      closeUserMenu();
    }
  } catch (e) { $('#authMsg').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

function doLogout() { saveToken(''); me = null; location.reload(); }

// Menú del avatar (header): saludo + accesos + cerrar sesión. El logo
// nunca choca con ningún botón: aquí solo hay un círculo.
function renderUserMenu() {
  const m = $('#userMenu');
  if (!me) { m.innerHTML = ''; m.classList.add('hidden'); return; }
  m.innerHTML = `<div class="um-name">Hola, ${esc(me.name)}</div>
    <div class="um-sub">${esc(me.email)} · ${me.role === 'photographer' ? 'Fotógrafo' : 'Deportista'}</div>
    <button id="umPhotos">Mis fotos</button>
    ${me.role === 'photographer' ? '<button id="umPanel">Panel fotógrafo</button>' : ''}
    <button id="umLogout">Cerrar sesión</button>`;
  m.querySelector('#umPhotos').onclick = () => { closeUserMenu(); showView('myphotos'); };
  const up = m.querySelector('#umPanel');
  if (up) up.onclick = () => { closeUserMenu(); showView('account'); };
  m.querySelector('#umLogout').onclick = doLogout;
}
function closeUserMenu() { $('#userMenu').classList.add('hidden'); }
document.addEventListener('click', (e) => {
  const m = $('#userMenu');
  if (!m.classList.contains('hidden') && !m.contains(e.target) && !(e.target.closest && e.target.closest('#avatarBtn'))) closeUserMenu();
});

// ---- Mensaje de cooperación voluntaria tras una descarga gratis ----
function showTipModal(clabe, name) {
  document.getElementById('tipModal')?.remove();
  const m = document.createElement('div');
  m.id = 'tipModal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
  m.innerHTML = `<div style="background:#17171c;color:#fff;border:1px solid #2a2a30;border-radius:12px;padding:20px;max-width:340px;text-align:center">
    <p>¡Gracias por descargar tu foto! Es gratis. Si te gustó el servicio y quieres cooperar para que sigamos en los eventos, te dejo mi CLABE:</p>
    <p style="font-size:20px;font-weight:bold;letter-spacing:1px">${esc(clabe)}</p>
    ${name ? `<p>A nombre de: <strong>${esc(name)}</strong></p>` : ''}
    <div class="row" style="justify-content:center"><button id="tipCopy" class="primary">Copiar CLABE</button><button id="tipClose">Cerrar</button></div>
    <p id="tipCopyMsg" class="muted"></p></div>`;
  document.body.appendChild(m);
  m.querySelector('#tipClose').onclick = () => m.remove();
  m.onclick = (e) => { if (e.target === m) m.remove(); };
  m.querySelector('#tipCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(clabe); m.querySelector('#tipCopyMsg').textContent = 'CLABE copiada.'; }
    catch (_) { m.querySelector('#tipCopyMsg').textContent = 'No se pudo copiar, cópiala a mano.'; }
  };
}

// ---- Descarga real: un solo botón "Guardar" / "Pagar y descargar" ----
// Gratis: registra la descarga en el servidor y dispara el <a> de mismo
// origen con download (Chrome Android guarda en Descargas / galería).
// De pago y sin comprar: crea el link de Clip y redirige al checkout
// seguro de Clip; al pagar, Clip nos devuelve y se descarga la foto.
async function savePhoto(photo, freeMode, priceMxn) {
  const price = Number(priceMxn || photo.price || 0);
  // La búsqueda es pública, pero descargar/comprar sí exige sesión:
  // sin sesión, primero se pide iniciar sesión (vista Cuenta).
  if (!token) {
    hideLightbox();
    alert('Inicia sesión para descargar tu foto.');
    showView('account');
    return;
  }
  const btns = document.querySelectorAll(`[data-save="${photo.id}"]`);
  btns.forEach(b => { b.disabled = true; b.textContent = 'Guardando…'; });
  try {
    // Si ya es tuya (comprada o guardada antes), no se reclama ni se
    // cobra de nuevo: directo a descargar.
    if (!photo.owned) {
      if (freeMode) await api('/api/claim', { method: 'POST', body: JSON.stringify({ photoIds: [photo.id] }) });
      else {
        const r = await api('/api/checkout-create', { method: 'POST', body: JSON.stringify({ photoId: photo.id }) });
        if (r.paid) { /* ya era tuya: seguir a descargar */ }
        else if (r.checkoutUrl) {
          btns.forEach(b => { b.textContent = 'Abriendo pago seguro…'; });
          location.href = r.checkoutUrl;
          return;
        } else throw new Error('No se pudo crear el pago con Clip.');
      }
    }
    // Descargar con fetch + blob, mandando el token de sesión como
    // Authorization Bearer (la sesión vive en localStorage, no en
    // cookie): el <a download> directo y un fetch sin el header no
    // mandan el token y el servidor contesta 401 en fotos de pago.
    // En Android además el gestor de descargas re-pide la URL sin
    // sesión. El blob vive en la página, así que no hay segunda
    // petición sin sesión.
    const dlHeaders = {};
    if (token) dlHeaders.Authorization = 'Bearer ' + token;
    const res = await fetch(`/api/photo?id=${photo.id}`, { headers: dlHeaders });
    if (!res.ok) throw new Error('No se pudo descargar la foto (' + res.status + ').');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `onlyclick-foto-${photo.id}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    btns.forEach(b => { b.textContent = isInAppBrowser() ? 'Revisa Descargas — si no está, usa "Abrir la foto"' : '✓ Guardar iniciada — busca la foto en Descargas'; });
    // La propina va al fotógrafo DE ESTA FOTO (en un evento compartido
    // cada quien recibe la suya); si la foto no trae, cae al evento.
    const tipC = photo.tipClabe || currentTipClabe;
    const tipN = photo.tipName || currentTipName;
    if (freeMode && tipC) showTipModal(tipC, tipN);
    removeFromCart(photo.id); // si estaba en el carrito, ya es tuya
    setTimeout(() => loadEventDetail(currentEvent), 1500);
  } catch (e) {
    alert('No se pudo guardar: ' + e.message);
    btns.forEach(b => { b.disabled = false; b.textContent = freeMode ? 'Guardar gratis' : (photo.owned ? 'Guardar' : 'Pagar y descargar · $' + price + ' MXN'); });
  }
}

// ---- Regreso desde Clip (pago) ----
// Clip redirige a /api/checkout-return, que verifica con Clip y nos
// devuelve aquí con ?event=&photo=&paid=1 | pay=pending | pay=failed.
async function handlePayReturn() {
  const q = new URLSearchParams(location.search);
  const paid = q.get('paid'), pay = q.get('pay');
  const eventId = Number(q.get('event') || 0), photoId = Number(q.get('photo') || 0);
  // Regreso de un carrito: ?view=cart&pid=<payment_request_id>&paid=1 | pay=...
  const view = q.get('view'), pid = q.get('pid');
  if (view === 'cart' && (paid || pay)) {
    history.replaceState({}, '', location.pathname);
    handleCartReturn(pid, paid, pay);
    return;
  }
  if (!paid && !pay) return;
  history.replaceState({}, '', location.pathname);
  if (paid === '1' && eventId && photoId) {
    alert('¡Pago confirmado! Descargando tu foto…');
    removeFromCart(photoId);
    try {
      const dlHeaders = {};
      if (token) dlHeaders.Authorization = 'Bearer ' + token;
      const res = await fetch(`/api/photo?id=${photoId}`, { headers: dlHeaders });
      if (!res.ok) throw new Error('descarga ' + res.status);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl; a.download = `onlyclick-foto-${photoId}.jpg`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    } catch (e) { alert('El pago quedó registrado, pero la descarga falló. Abre la foto en el evento y dale "Guardar".'); }
    showView('events'); loadEventDetail(eventId);
    return;
  }
  if (pay === 'pending') {
    alert('Tu pago está en proceso (puede ser efectivo en OXXO o confirmación pendiente). En cuanto Clip lo confirme, la foto aparecerá en "Mis fotos".');
    if (eventId && photoId) pollPayment(photoId);
    return;
  }
  if (pay === 'failed') alert('El pago no se completó (cancelado o vencido). Puedes intentarlo de nuevo con "Pagar y descargar".');
  if (pay === 'error') alert('No se pudo verificar el pago. Revisa "Mis fotos" en unos minutos; si no aparece, inténtalo de nuevo.');
}
// Pregunta cada 5 s (máx 2 min) si un pago pendiente ya se confirmó.
async function pollPayment(photoId) {
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const s = await api('/api/checkout-status', { method: 'POST', body: JSON.stringify({ photoId }) });
      if (s.paid) {
        alert('¡Pago confirmado! Descargando tu foto…');
        try {
          const dlHeaders = {};
          if (token) dlHeaders.Authorization = 'Bearer ' + token;
          const res = await fetch(`/api/photo?id=${photoId}`, { headers: dlHeaders });
          if (!res.ok) throw new Error('descarga ' + res.status);
          const blob = await res.blob();
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl; a.download = `onlyclick-foto-${photoId}.jpg`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
        } catch (e) { alert('El pago quedó registrado, pero la descarga falló. Abre la foto en el evento y dale "Guardar".'); }
        return;
      }
      if (s.status === 'cancelled' || s.status === 'expired') return;
    } catch (_) { return; }
  }
}

// ---- Vista del carrito ----
function renderCartView() {
  const box = $('#cartBox');
  if (!cart.length) {
    box.innerHTML = '<p>Tu carrito está vacío. Busca tu dorsal y agrega tus fotos.</p><button class="primary" id="cartGoHome">Buscar mis fotos</button>';
    $('#cartGoHome').onclick = () => showView('home');
    return;
  }
  const t = cartTotals(cart);
  const byId = {};
  cart.forEach(it => { byId[it.id] = it; });
  const lineById = {};
  t.lines.forEach(l => { lineById[l.id] = l; });
  const upsell = packageUpsell();
  // Líneas por separado: primero los paquetes, luego las individuales.
  const packageRows = t.packages.map((pkg, pi) => {
    const first = byId[pkg.photoIds[0]];
    const bibs = pkg.photoIds.map(id => (byId[id] && (byId[id].bibs || []).join(', ')) || 'sin dorsal').join(', ');
    return `<div class="cart-row cart-package">
      <img src="/api/photo?id=${pkg.photoIds[0]}&thumb=1&inline=1" alt="" loading="lazy">
      <div class="cart-info"><strong>Paquete de 10 fotos</strong><span class="muted">Dorsales: ${esc(bibs)}${first && first.eventName ? ' · ' + esc(first.eventName) : ''}</span></div>
      <div class="cart-price"><s class="muted">$${pkg.subtotal}</s> <strong>$${pkg.total} MXN</strong> <span class="badge">-25%</span></div>
      <button data-rmpackage="${pi}" class="secondary">Quitar paquete</button>
    </div>`;
  }).join('');
  const singleRows = t.lines.map(l => {
    const it = byId[l.id];
    return `<div class="cart-row">
      <img src="/api/photo?id=${it.id}&thumb=1&inline=1" alt="" loading="lazy">
      <div class="cart-info"><strong>Dorsal ${esc((it.bibs || []).join(', ') || 'sin dorsal')}</strong><span class="muted">${esc(it.eventName || '')}</span></div>
      <div class="cart-price">${l.discount ? `<s class="muted">$${l.price}</s> <strong>$${l.lineTotal} MXN</strong> <span class="badge">-${Math.round(l.discount * 100)}%</span>` : `<strong>$${l.lineTotal} MXN</strong>`}</div>
      <button data-rmcart="${it.id}" class="secondary">Quitar</button>
    </div>`;
  }).join('');
  box.innerHTML = '<p class="muted">' + cart.length + ' foto(s) · Individuales: 1-3 a precio normal, 4a y 5a con -20%. Cada 10 fotos forman un Paquete de 10 con -25%.</p>' +
    (upsell ? `<p class="cart-upsell">Agrega ${upsell.missing} foto(s) más y llévate el paquete de 10 por $${upsell.packageTotal}.</p>` : '') +
    packageRows + singleRows +
    `<div class="card"><p>Subtotal: $${t.subtotal} MXN</p><p>Descuento: -$${t.discount} MXN</p><p><strong>Total a pagar: $${t.total} MXN</strong></p>
    ${t.total > CART_MAX_TOTAL ? `<p class="error">El total supera el límite de $${CART_MAX_TOTAL} MXN por pago de Clip. Quita fotos o divide tu compra en dos.</p>` : ''}
    <div class="row"><button id="cartPay" class="primary" ${t.total > CART_MAX_TOTAL ? 'disabled' : ''}>Pagar todo · $${t.total} MXN</button><button id="cartClear" class="secondary">Vaciar carrito</button></div>
    <p class="muted">Pagas una sola vez con Clip (tarjeta o efectivo). Tus fotos quedan en "Mis fotos".</p></div>`;
  box.querySelectorAll('[data-rmcart]').forEach(b => b.onclick = () => { removeFromCart(Number(b.dataset.rmcart)); renderCartView(); });
  box.querySelectorAll('[data-rmpackage]').forEach(b => b.onclick = () => {
    const pkg = t.packages[Number(b.dataset.rmpackage)];
    if (!pkg) return;
    if (!confirm('¿Quitar el paquete de 10 fotos del carrito?')) return;
    pkg.photoIds.forEach(id => removeFromCart(id));
    renderCartView();
  });
  $('#cartPay').onclick = checkoutCart;
  $('#cartClear').onclick = () => { if (confirm('¿Vaciar el carrito?')) { clearCart(); renderCartView(); } };
}

async function checkoutCart() {
  if (!cart.length) return;
  // Pagar exige sesión, igual que comprar una foto suelta.
  if (!token) { alert('Inicia sesión para pagar tu carrito.'); showView('account'); return; }
  const t = cartTotals(cart);
  if (t.total > CART_MAX_TOTAL) { alert('El total supera el límite de $' + CART_MAX_TOTAL + ' MXN por pago de Clip. Divide tu compra en dos.'); return; }
  const btn = $('#cartPay');
  if (btn) { btn.disabled = true; btn.textContent = 'Abriendo pago seguro…'; }
  try {
    const r = await api('/api/checkout-create-cart', { method: 'POST', body: JSON.stringify({ photoIds: cart.map(x => x.id) }) });
    if (r.paid) { clearCart(); alert('¡Listo! Esas fotos ya eran tuyas.'); showView('myphotos'); return; }
    if (r.checkoutUrl) { location.href = r.checkoutUrl; return; }
    throw new Error('No se pudo crear el pago con Clip.');
  } catch (e) {
    // La foto ya no existe o pasó a gratis: se quita sola del carrito.
    const gone = /Foto no encontrada: (\d+)/.exec(e.message);
    const freeNow = /La foto (\d+) es de un evento gratis/.exec(e.message);
    if (gone) { removeFromCart(Number(gone[1])); renderCartView(); alert('Una foto del carrito ya no existe y se quitó. Inténtalo de nuevo.'); return; }
    if (freeNow) { removeFromCart(Number(freeNow[1])); renderCartView(); alert('Una foto ahora es gratis: se quitó del carrito, descárgala gratis desde el evento.'); return; }
    alert('No se pudo pagar el carrito: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Pagar todo · $' + t.total + ' MXN'; }
  }
}

// Descarga con fetch + blob (igual que la descarga de una foto): el
// token va en el header porque la sesión vive en localStorage.
async function downloadPhotoBlob(photoId) {
  const dlHeaders = {};
  if (token) dlHeaders.Authorization = 'Bearer ' + token;
  const res = await fetch(`/api/photo?id=${photoId}`, { headers: dlHeaders });
  if (!res.ok) throw new Error('descarga ' + res.status);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl; a.download = `onlyclick-foto-${photoId}.jpg`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
}

async function downloadCartPhotos(ids) {
  for (const id of ids) {
    try { await downloadPhotoBlob(id); } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
  }
  alert('Descargas iniciadas — busca las fotos en Descargas.');
}

function cartPaidBox(photoIds) {
  const n = photoIds.length;
  const box = $('#cartBox');
  box.innerHTML = `<div class="card"><h3>¡Pago confirmado!</h3><p>${n} foto(s) ya son tuyas y están en "Mis fotos".</p><div class="row"><button id="cartDlAll" class="primary">Descargar todas</button><button id="cartGoPhotos" class="secondary">Ver en Mis fotos</button></div></div>`;
  $('#cartGoPhotos').onclick = () => showView('myphotos');
  $('#cartDlAll').onclick = () => downloadCartPhotos(photoIds);
}

// Regreso desde Clip tras pagar un carrito (?view=cart&pid=...).
async function handleCartReturn(pid, paid, pay) {
  showView('cart');
  const box = $('#cartBox');
  if (paid === '1') {
    box.innerHTML = '<p>Verificando tu pago…</p>';
    try {
      const s = await api('/api/checkout-status', { method: 'POST', body: JSON.stringify({ paymentRequestId: pid }) });
      if (s.paid) { clearCart(); cartPaidBox(s.photoIds || []); return; }
      box.innerHTML = '<p>Tu pago está en proceso. En cuanto Clip lo confirme, las fotos aparecerán en "Mis fotos".</p>';
      pollCartPayment(pid);
      return;
    } catch (_) {
      box.innerHTML = '<p>No se pudo verificar el pago todavía. Revisa "Mis fotos" en unos minutos.</p>';
      return;
    }
  }
  if (pay === 'pending') {
    alert('Tu pago está en proceso (puede ser efectivo en OXXO o confirmación pendiente). En cuanto Clip lo confirme, las fotos aparecerán en "Mis fotos".');
    pollCartPayment(pid);
    return;
  }
  if (pay === 'failed') { alert('El pago no se completó (cancelado o vencido). Tu carrito sigue intacto, puedes intentarlo de nuevo.'); renderCartView(); return; }
  if (pay === 'error') { alert('No se pudo verificar el pago. Revisa "Mis fotos" en unos minutos; si no aparece, inténtalo de nuevo.'); renderCartView(); }
}
// Pregunta cada 5 s (máx 2 min) si un pago de carrito ya se confirmó.
async function pollCartPayment(pid) {
  if (!pid) return;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const s = await api('/api/checkout-status', { method: 'POST', body: JSON.stringify({ paymentRequestId: pid }) });
      if (s.paid) {
        clearCart();
        alert('¡Pago confirmado! ' + (s.photoIds || []).length + ' foto(s) ya son tuyas.');
        if (currentView === 'cart') cartPaidBox(s.photoIds || []);
        return;
      }
      if (s.status === 'cancelled' || s.status === 'expired') return;
    } catch (_) { return; }
  }
}

function photoCard(p) {
  const freeMode = p.freeMode !== false;
  const price = Number(p.priceMxn || p.price || 0);
  const bibs = (p.bibs || []).map(b => `<span class="badge">Dorsal ${esc(b)}</span>`).join('');
  return `<div class="photo">
    <img src="/api/photo?id=${p.id}&thumb=1&inline=1" loading="lazy" decoding="async" alt="Foto dorsal ${(p.bibs || []).join(', ')}" data-open="${p.id}">
    <div class="meta">${bibs || '<span class="muted">Sin dorsal</span>'}
      ${freeMode ? '<span class="badge free">Gratis</span>' : `<span class="badge">$${price} MXN</span>`}
      ${p.owned ? '<span class="badge owned">Tuya</span>' : ''}
      ${p.photographerName ? `<span class="muted">Foto de ${esc(p.photographerName)}</span>` : ''}
      <button data-save="${p.id}" class="primary">${freeMode ? 'Guardar gratis' : (p.owned ? 'Guardar' : 'Pagar y descargar · $' + price + ' MXN')}</button>
      ${!freeMode && !p.owned ? `<button data-cart="${p.id}" class="secondary cart-btn" ${cartHas(p.id) ? 'disabled' : ''}>${cartHas(p.id) ? 'En el carrito ✓' : 'Agregar al carrito'}</button>` : ''}
    </div></div>`;
}

function bindPhotos(photos) {
  document.querySelectorAll('[data-save]').forEach(b => b.onclick = () => {
    const p = photos.find(x => x.id === Number(b.dataset.save)) || currentPhotos.find(x => x.id === Number(b.dataset.save));
    if (p) savePhoto(p, p.freeMode !== false, p.priceMxn);
  });
  document.querySelectorAll('[data-cart]').forEach(b => b.onclick = () => {
    const p = photos.find(x => x.id === Number(b.dataset.cart)) || currentPhotos.find(x => x.id === Number(b.dataset.cart));
    if (p) addToCart(p);
  });
  document.querySelectorAll('[data-open]').forEach(img => img.onclick = () => {
    const p = photos.find(x => x.id === Number(img.dataset.open));
    if (!p) return;
    lightboxPhoto = p;
    trackView('photo', p.id, p.eventId || null);
    const freeMode = p.freeMode !== false;
    const price = Number(p.priceMxn || p.price || 0);
    lightboxFreeMode = freeMode;
    lightboxPriceMxn = price;
    $('#lbImg').src = `/api/photo?id=${p.id}&inline=1`;
    $('#lbInfo').textContent = `Dorsal: ${(p.bibs || []).join(', ') || 'sin dorsal'} · ${freeMode ? 'Descarga gratis' : '$' + price + ' MXN'}` + (p.photographerName ? ` · Foto de ${p.photographerName}` : '');
    $('#lbSave').textContent = freeMode ? 'Guardar gratis' : (p.owned ? 'Guardar' : 'Pagar y descargar · $' + price + ' MXN');
    $('#lbSave').dataset.save = p.id;
    // En el navegador de Facebook/Instagram: botón para abrir la foto
    // en una pestaña nueva (ahí se puede guardar con pulsación larga).
    const lbOpen = $('#lbOpen');
    lbOpen.style.display = isInAppBrowser() ? '' : 'none';
    lbOpen.onclick = () => { const u = '/api/photo?id=' + p.id + '&inline=1' + (token ? '&token=' + encodeURIComponent(token) : ''); window.open(u, '_blank'); };
    // Botón del carrito en la vista ampliada: solo fotos de pago sin comprar.
    const lbCart = $('#lbCart');
    lbCart.style.display = (!freeMode && !p.owned) ? '' : 'none';
    lbCart.dataset.cart = p.id;
    lbCart.disabled = cartHas(p.id);
    lbCart.textContent = cartHas(p.id) ? 'En el carrito ✓' : 'Agregar al carrito';
    // Marca de agua en la vista previa de pago: el servidor ya sirve la
    // miniatura en vez del original; este texto va encima.
    $('#lbWm').style.display = (!freeMode && !p.owned) ? 'flex' : 'none';
    $('#lightbox').style.display = 'flex';
    lightboxPushed = true;
    lastBackAtHome = 0;
    pushNav({ view: currentView, lightbox: p.id });
  });
}

async function searchBib() {
  const bib = $('#bibInput').value.trim();
  if (!bib) return;
  const box = $('#searchResults');
  if (bib.includes('@')) { box.innerHTML = '<p>Escribe solo tu número de dorsal, sin correo.</p>'; return; }
  box.innerHTML = '<p>Buscando…</p>';
  try {
    const r = await api('/api/search?bib=' + encodeURIComponent(bib));
    currentPhotos = r.photos;
    box.innerHTML = r.photos.length
      ? `<p>${r.photos.length} foto(s) con el dorsal ${esc(bib)}:</p><div class="grid">${r.photos.map(p => photoCard(p)).join('')}</div>`
      : `<p>No hay fotos con el dorsal ${esc(bib)} en ningún evento.</p>`;
    bindPhotos(r.photos);
    trackView('search', null, null, bib);
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

// Tarjeta de evento: portada, nombre, fecha, fotos reales y precio real
// por foto ("Desde $X MXN/foto" o "Descarga gratis"). NUNCA se inventan
// eventos ni precios: solo se muestran los que devuelve /api/events.
// PAQUETE: mostrar cuando Orlan defina el precio — p. ej. una línea
// "Todas tus fotos $Y MXN" junto al precio por foto. No mostrar precio
// inventado.
function eventCard(e) {
  const price = Number(e.priceMxn || 20);
  const priceTxt = e.freeMode ? 'Descarga gratis' : 'Desde $' + price + ' MXN/foto';
  return `<div class="event-card" data-ev="${e.id}" role="button" tabindex="0">
    ${e.coverPath ? `<img class="event-cover" src="/api/cover?eventId=${e.id}" alt="" loading="lazy">` : '<div class="event-cover event-cover-empty"></div>'}
    <div class="event-body">
      <strong>${esc(e.name)}</strong> ${e.isOfficial ? '<span class="badge official">✓ Álbum oficial Only Click</span>' : ''}
      ${e.photographerName ? `<span class="muted">Fotos de ${esc(e.photographerName)}</span>` : ''}
      ${e.isShared ? `<span class="badge">Evento compartido · ${e.participantsCount || 2} fotógrafos</span>` : ''}
      <span class="muted">${esc(e.sport)} · ${esc(e.eventDate)} · ${esc(e.location)}</span>
      <span class="event-meta">${e.photoCount || 0} fotos · ${priceTxt}</span>
      <span class="event-cta">Ver fotos →</span>
    </div></div>`;
}

function bindEventCards() {
  document.querySelectorAll('[data-ev]').forEach(b => {
    b.onclick = () => loadEventDetail(Number(b.dataset.ev), true);
    b.onkeydown = (e) => { if (e.key === 'Enter') loadEventDetail(Number(b.dataset.ev), true); };
  });
}

// Inicio (público, sin login): hero con la portada y los datos reales del
// evento más reciente + tarjetas de eventos recientes.
async function loadHome() {
  try {
    const r = await api('/api/events');
    const evs = r.events || [];
    const hero = $('#hero');
    if (evs.length) {
      const ev = [...evs].sort((a, b) => String(b.eventDate || '').localeCompare(String(a.eventDate || '')))[0];
      // Título genérico: la búsqueda del hero es global (todos los eventos),
      // el evento más reciente solo se destaca como referencia.
      $('#heroTitle').textContent = 'Encuentra tus fotos';
      $('#heroSub').textContent = 'Evento reciente: ' + ev.name + ' · ' + (ev.photoCount || 0) + ' fotos listas' + (ev.location ? ' · ' + ev.location : '') + (ev.eventDate ? ' · ' + ev.eventDate : '');
      hero.style.backgroundImage = ev.coverPath
        ? 'linear-gradient(rgba(11,11,14,.60), rgba(11,11,14,.88)), url("/api/cover?eventId=' + ev.id + '")'
        : '';
    } else {
      $('#heroTitle').textContent = 'Encuentra tus fotos';
      $('#heroSub').textContent = 'Aún no hay eventos publicados.';
      hero.style.backgroundImage = '';
    }
    $('#homeEvents').innerHTML = evs.length ? evs.map(e => eventCard(e)).join('') : '<p class="muted">Aún no hay eventos publicados.</p>';
    bindEventCards();
  } catch (e) {
    $('#heroSub').textContent = 'No se pudieron cargar los eventos.';
  }
}

async function loadEvents() {
  const r = await api('/api/events');
  $('#eventList').innerHTML = r.events.length ? r.events.map(e => eventCard(e)).join('') : '<p>No hay eventos todavía.</p>';
  bindEventCards();
}

async function loadEventDetail(eventId, push) {
  currentEvent = eventId;
  // El detalle vive dentro de la vista de eventos (oculta desde el inicio):
  // sin cambiar a esa vista, el detalle se dibujaba escondido y el clic
  // parecía no hacer nada.
  showView('events');
  if (push) pushNav({ view: 'events', event: eventId });
  const r = await api('/api/event-get?eventId=' + eventId);
  currentPhotos = r.photos;
  currentTipClabe = r.tipClabe || '';
  currentTipName = r.tipName || '';
  // El precio por foto ya viene del servidor (cada fotógrafo el suyo):
  // aquí solo se marca si el evento es gratis.
  r.photos.forEach(p => { p.freeMode = r.event.freeMode; });
  $('#eventDetail').innerHTML = `
    <h3>${esc(r.event.name)}</h3>
    ${r.isOfficial ? '<p><span class="badge official">✓ Álbum oficial Only Click</span></p>' : ''}
    ${r.photographerName ? `<p class="muted">Fotos de ${esc(r.photographerName)}</p>` : ''}
    ${r.participants && r.participants.length > 1 ? `<p><span class="badge">Evento compartido · ${r.participants.length} fotógrafos</span></p><p class="muted">Participan: ${r.participants.map(pt => esc(pt.displayName) + ' ($' + pt.priceMxn + '/foto)').join(' · ')}</p>` : ''}
    ${me && me.role === 'photographer' && me.approved !== false && r.event.photographerId !== me.id ? (r.isParticipant
      ? `<p class="ok">Ya participas en este evento · Tu precio: $${r.myPrice || r.event.priceMxn} MXN por foto</p>`
      : `<div class="card"><p><strong>¿Vas a cubrir este evento?</strong> Únete y sube tus fotos aquí: cada quien vende las suyas a su precio.</p><div class="row"><input id="joinPrice" type="number" min="1" max="5000" value="20" style="max-width:130px"><button id="joinBtn" class="primary">Unirme a este evento</button></div><p id="joinStatus" class="muted"></p></div>`) : ''}
    ${r.event.coverPath ? `<img src="/api/cover?eventId=${eventId}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px">` : ''}
    <p class="muted">${esc(r.event.sport)} · ${esc(r.event.eventDate)} · ${esc(r.event.location)} · ${r.event.freeMode ? 'Descarga gratis' : 'De pago · $' + (r.event.priceMxn || 20) + ' MXN por foto'}</p>
    <div class="row"><input id="evBib" type="search" inputmode="numeric" autocomplete="one-time-code" name="dorsal-evento" autocapitalize="off" autocorrect="off" placeholder="Buscar dorsal en este evento"><button id="evBibBtn" class="primary">Buscar</button></div>
    <div class="grid" id="evGrid">${r.photos.map(p => photoCard(p)).join('') || '<p>No hay fotos todavía.</p>'}</div>`;
  bindPhotos(r.photos);
  trackView('event', null, eventId);
  const joinBtn = $('#joinBtn');
  if (joinBtn) joinBtn.onclick = async () => {
    try {
      await api('/api/join-event', { method: 'POST', body: JSON.stringify({ eventId, priceMxn: Number($('#joinPrice').value || 20) }) });
      loadEventDetail(eventId);
    } catch (e) { const st = $('#joinStatus'); if (st) st.textContent = e.message; }
  };
  $('#evBibBtn').onclick = async () => {
    const bib = $('#evBib').value.trim(); if (!bib) return;
    const s = await api('/api/search?bib=' + encodeURIComponent(bib) + '&eventId=' + eventId);
    currentPhotos = s.photos;
    s.photos.forEach(p => { p.freeMode = r.event.freeMode; });
    $('#evGrid').innerHTML = s.photos.map(p => photoCard(p)).join('') || '<p>No hay fotos con ese dorsal en este evento.</p>';
    bindPhotos(s.photos);
    trackView('search', null, eventId, bib);
  };
}

async function loadMyPhotos() {
  currentTipClabe = '';
  currentTipName = '';
  // "Mis fotos" sí exige sesión: sin sesión se invita a entrar, no se
  // llama a la API (devolvería 401).
  if (!me) {
    $('#myPhotosList').innerHTML = `<div class="card"><p>Inicia sesión para ver tus fotos guardadas y compradas.</p><button id="myPhotosLogin" class="primary">Iniciar sesión</button></div>`;
    $('#myPhotosLogin').onclick = () => showView('account');
    return;
  }
  const r = await api('/api/my-photos');
  $('#myPhotosList').innerHTML = r.photos.length ? `<div class="grid">${r.photos.map(p => photoCard(p)).join('')}</div>` : '<p>Todavía no tienes fotos guardadas.</p>';
  bindPhotos(r.photos);
}

// Dinero en MXN con 2 decimales.
function fmtMxn(n) { return '$' + Number(n || 0).toFixed(2) + ' MXN'; }
// Link de invitación de una solicitud aprobada: se arma con el origen
// actual (onlyclick-zeta.vercel.app hoy, onlyclick.com.mx cuando esté el
// dominio) y el token guardado en la solicitud.
function appInviteHtml(a) {
  const url = location.origin + '/?invite=' + encodeURIComponent(a.inviteToken || '');
  return `<p class="ok">Aprobada — link de invitación (vale hasta ${esc(String(a.inviteExpiresAt || '').slice(0, 10))}):</p>
  <p style="word-break:break-all"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>
  <button data-copyinvite="${a.id}">Copiar link</button>
  <button data-app-wa="${a.id}" class="primary">Enviar por WhatsApp</button>`;
}

async function loadPhotographer() {
  const box = $('#photoPanel');
  if (!me || me.role !== 'photographer') { box.innerHTML = '<p>Solo la cuenta de fotógrafo ve este panel.</p>'; return; }
  const events = (await api('/api/events')).events;
  // Cada fotógrafo ve solo SUS eventos en el panel; el dueño ve todos.
  const myEvents = me.isOwner ? events : events.filter(e => e.photographerId === me.id);
  // Eventos compartidos en los que participo (no los creé): también puedo
  // subir mis fotos ahí, a mi precio.
  const joinedEvents = me.isOwner ? [] : events.filter(e => e.photographerId !== me.id && e.joined);
  const approved = me.isOwner || me.approved !== false;
  // Cooperación voluntaria: bloqueada cuando TODOS sus álbumes son de pago
  // (el mensaje de propina solo sale en fotos gratis). Sin álbumes todavía,
  // se permite guardarla para cuando cree uno gratis.
  const tipEvents = [...myEvents, ...joinedEvents];
  const tipBlocked = tipEvents.length > 0 && !tipEvents.some(e => e.freeMode);
  const sales = await api('/api/sales').catch(() => ({ sales: [], totalDownloads: 0, freeDownloads: 0, revenue: 0 }));
  const stats = await api('/api/stats').catch(() => ({ totals: { photoViews: 0, uniqueViewers: 0, eventViews: 0, totalDownloads: 0, freeDownloads: 0, revenue: 0 }, events: [], topPhotos: [], topBibs: [] }));
  const earnings = await api('/api/my-earnings').catch(() => null);
  const payouts = me.isOwner ? await api('/api/payouts-summary').catch(() => null) : null;
  const payoutHistory = me.isOwner ? await api('/api/payouts-history').catch(() => ({ payouts: [] })) : null;
  const photographers = me.isOwner ? await api('/api/list-photographers').catch(() => ({ photographers: [] })) : null;
  const applications = me.isOwner ? await api('/api/list-applications').catch(() => ({ applications: [] })) : null;
  // Cuenta pendiente de aprobación: no puede crear eventos ni vender
  // todavía. Sí puede dejar su CLABE de pagos y ver sus ganancias (en
  // ceros hasta que venda).
  if (!approved) {
    box.innerHTML = `
    <p class="error">Tu cuenta de fotógrafo está pendiente de aprobación por ONLYCLICK. En cuanto te aprueben podrás crear eventos y subir fotos.</p>
    <h3>CLABE para recibir tus pagos</h3>
    <p class="muted">Cuando vendas fotos, ONLYCLICK te manda tu parte a esta CLABE cada 72 horas. Son 18 dígitos.</p>
    <div class="row"><input id="payClabe" inputmode="numeric" placeholder="Tu CLABE (18 dígitos)" value="${esc(me.payoutClabe || '')}" style="flex:1"><button id="paySave" class="primary">Guardar CLABE</button></div>
    <p id="payStatus" class="muted"></p>
    <h3>Mis ganancias</h3>
    ${earnings ? `<p>Total vendido: ${fmtMxn(earnings.totalSold)} · Mi parte pendiente: ${fmtMxn(earnings.pendingBalance)} · Ya me pagaron: ${fmtMxn(earnings.paidShare)}</p>` : '<p class="muted">Sin datos todavía.</p>'}`;
    $('#paySave').onclick = async () => {
      try { const r = await api('/api/set-payout-clabe', { method: 'POST', body: JSON.stringify({ clabe: $('#payClabe').value }) }); me.payoutClabe = r.payoutClabe || ''; $('#payStatus').textContent = 'CLABE guardada.'; } catch (e) { $('#payStatus').textContent = e.message; }
    };
    return;
  }
  const dueCount = payouts ? (payouts.photographers || []).filter(p => p.isDue && p.pendingBalance > 0).length : 0;
  // Solicitudes de fotógrafos: pendientes (con toda la info para decidir),
  // aprobadas con link pendiente de usar, y revisadas (historial).
  const apps = (applications && applications.applications) || [];
  const appsPending = apps.filter(a => a.status === 'pending');
  const appsOpen = apps.filter(a => a.status === 'approved' && a.photographerId == null);
  const appsReviewed = apps.filter(a => a.status === 'rejected' || (a.status === 'approved' && a.photographerId != null));
  const appCard = (a, withActions) => `
    <div class="card">
      <p><strong>${esc(a.name)}</strong> · ${esc(a.city)} · <span class="muted">${String(a.createdAt || '').slice(0, 10)}</span></p>
      <p class="muted">WhatsApp: ${esc(a.phone)} · Eventos: ${esc(a.events)}</p>
      <p class="muted">Cámara: ${esc(a.camera || '—')} · Especialidad: ${esc(a.specialty || '—')}</p>
      <p class="muted">Experiencia con dorsal: ${esc(a.dorsalExp || '—')} · Disponibilidad: ${esc(a.availability || '—')}</p>
      <p class="muted">CLABE para pagos: ${esc(a.clabe || '—')}</p>
      <p class="muted">Trabajo: <a href="${esc(a.sampleLink)}" target="_blank" rel="noopener">${esc(a.sampleLink)}</a></p>
      ${a.message ? `<p class="muted">Mensaje: ${esc(a.message)}</p>` : ''}
      ${withActions ? `<button data-app-approve="${a.id}" class="primary">Aprobar</button> <button data-app-reject="${a.id}">Rechazar</button>` : appInviteHtml(a)}
    </div>`;
  const solicitudesHtml = me.isOwner ? `
    <h3>Solicitudes</h3>
    <p class="muted">Fotógrafos que llenaron el formulario del inicio. Aprueba al que te guste y se le genera un link para crear su cuenta; si no te convence, recházalo.</p>
    ${appsPending.length || appsOpen.length ? `<div data-pg="applications">${appsPending.map(a => appCard(a, true)).join('')}${appsOpen.map(a => appCard(a, false)).join('')}</div><div data-pg-controls="applications"></div>` : '<p class="muted">No hay solicitudes pendientes.</p>'}
    ${appsReviewed.length ? `<details><summary>Revisadas (${appsReviewed.length})</summary>${appsReviewed.map(a => `<p class="muted">${esc(a.name)} · ${a.status === 'approved' ? 'Aprobada' : 'Rechazada'} · ${String(a.createdAt || '').slice(0, 10)}</p>`).join('')}</details>` : ''}` : '';
  // Al recargar el panel las listas vuelven a la página 1 (la pestaña
  // activa sí se recuerda mientras se navega).
  panelPages = {};
  const panelTabs = me.isOwner
    ? [['ventas', 'Ventas'], ['estadisticas', 'Estadísticas'], ['fotografos', 'Fotógrafos'], ['gestion', 'Gestión']]
    : [['ventas', 'Ventas'], ['estadisticas', 'Estadísticas'], ['ganancias', 'Mis ganancias'], ['gestion', 'Gestión']];
  if (!panelTabs.some(t => t[0] === panelTab)) panelTab = 'ventas';
  // "Mis ganancias" es el mismo bloque para todos: el dueño lo ve dentro
  // de la pestaña Fotógrafos y los demás fotógrafos en su propia pestaña.
  const earningsHtml = earnings ? `<p>Total vendido: ${fmtMxn(earnings.totalSold)} · Comisión Clip: ${fmtMxn(earnings.clipFee)} · Comisión ONLYCLICK (10%): ${fmtMxn(earnings.orlanFee)}</p><p><strong>Mi parte: ${fmtMxn(earnings.photographerShare)}</strong> · Pendiente por pagarme: ${fmtMxn(earnings.pendingBalance)} · Ya me pagaron: ${fmtMxn(earnings.paidShare)}${earnings.lastPayout ? ` · Último pago: ${fmtMxn(earnings.lastPayout.amountMxn)} el ${String(earnings.lastPayout.paidAt || '').slice(0, 10)}` : ''}</p><p class="muted">ONLYCLICK te paga tu parte cada 72 horas a tu CLABE. Clip quita 4.18% primero y ONLYCLICK se queda el 10% de lo que queda.</p>` : '<p class="muted">Sin datos todavía.</p>';
  box.innerHTML = `
    ${dueCount ? `<p class="error">● Tienes ${dueCount} pago(s) a fotógrafos vencido(s) (72 h). Revisa la pestaña "Fotógrafos".</p>` : ''}
    <!-- Accesos rápidos: lo más usado del panel, a la vista desde que se abre -->
    <div class="row" style="gap:8px;margin-bottom:12px">
      <button class="primary" style="flex:1 1 45%;padding:14px" onclick="goPanelSection('gestion','secCrearEvento')">Crear evento</button>
      <button style="flex:1 1 45%;padding:14px" onclick="goPanelSection('gestion','secSubirFotos')">Subir fotos</button>
      <button style="flex:1 1 45%;padding:14px" onclick="goPanelSection('gestion','secMisEventos')">Mis eventos</button>
      <button style="flex:1 1 45%;padding:14px" onclick="goPanelSection('ventas')">Fotos vendidas</button>
      <button style="flex:1 1 45%;padding:14px" onclick="goPanelSection('estadisticas')">Estadísticas</button>
    </div>
    <div class="row" style="gap:6px;margin-bottom:12px">${panelTabs.map(t => `<button data-panel-tabbtn="${t[0]}" style="flex:0 0 auto;min-width:0">${t[1]}</button>`).join('')}</div>
    <section data-tabpanel="gestion">
    <h3 id="secCrearEvento">Crear evento</h3>
    <input id="evName" placeholder="Nombre del evento (ej. Ensenada medio)">
    <div class="row"><input id="evSport" placeholder="Deporte" value="Carrera"><input id="evDate" type="date"><input id="evPlace" placeholder="Lugar"></div>
    <button id="evCreate" class="primary">Crear evento</button>
    <h3>Nombre que se muestra en tus fotos</h3>
    <p class="muted">Así sale en cada foto: "Foto de …". Puede ser tu primer nombre, un apodo o el nombre de tu marca o página. Si lo dejas vacío, sale tu primer nombre.</p>
    <div class="row"><input id="displayName" placeholder="Ej. Only Dust" value="${esc(me.displayName || '')}" maxlength="40" style="flex:1"><button id="displaySave" class="primary">Guardar nombre</button></div>
    <p id="displayStatus" class="muted"></p>
    <h3>Cooperación voluntaria</h3>
    <p class="muted">Si pones tu CLABE aquí, al descargar una foto gratis les aparecerá un mensaje invitándolos a cooperar. La CLABE solo sirve para recibir depósitos.</p>
    ${tipBlocked ? '<p class="muted">Tus álbumes son de pago, así que la cooperación voluntaria está desactivada. Si cambias un álbum a gratis, se activa de nuevo.</p>' : ''}
    <div class="row"><input id="tipClabe" inputmode="numeric" placeholder="Tu CLABE (18 dígitos)" value="${esc(me.tipClabe || '')}" style="flex:1"${tipBlocked ? ' disabled' : ''}><button id="tipSave" class="primary"${tipBlocked ? ' disabled' : ''}>Guardar CLABE</button></div>
    <p id="tipStatus" class="muted"></p>
    <h3>CLABE para recibir tus pagos</h3>
    <p class="muted">Cuando vendas fotos, ONLYCLICK te manda tu parte (90% de lo que queda después de Clip) a esta CLABE cada 72 horas. Son 18 dígitos.</p>
    <div class="row"><input id="payClabe" inputmode="numeric" placeholder="Tu CLABE (18 dígitos)" value="${esc(me.payoutClabe || '')}" style="flex:1"><button id="paySave" class="primary">Guardar CLABE</button></div>
    <p id="payStatus" class="muted"></p>
    <h3 id="secSubirFotos">Subir fotos</h3>
    <select id="upEvent">${myEvents.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}${joinedEvents.map(e => `<option value="${e.id}">${esc(e.name)} · participas</option>`).join('')}</select>
    <input id="upFiles" type="file" accept="image/*" multiple>
    <input id="upPrice" type="number" placeholder="Precio por foto en MXN (0 si es gratis)" value="0">
    <div id="upList"></div>
    <p id="upStatus" class="muted"></p>
    <button id="upBtn" class="primary">Subir fotos</button>
    <p class="muted">Al terminar de subirse, los dorsales se leen solos con IA y se guardan. Si alguna queda sin dorsal, usa "Leer dorsales en lote" en Revisar dorsales.</p>
    <h3>Portada del evento</h3>
    <p class="muted">Una foto aparte que se ve en la lista de eventos. Elige el evento y sube la foto.</p>
    <div class="row"><select id="covEvent">${myEvents.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select><input id="covFile" type="file" accept="image/*"></div>
    <div id="covPreview"></div>
    <button id="covBtn" class="primary">Subir portada</button>
    <p id="covStatus" class="muted"></p>
    <h3 id="secMisEventos">Mis eventos</h3>
    <div data-pg="events">${myEvents.map(e => `<p><strong>${esc(e.name)}</strong> — ${e.photoCount || 0} foto(s) · ${e.freeMode ? 'Gratis' : 'De pago'} <button data-free="${e.id}">${e.freeMode ? 'Cambiar a pago' : 'Cambiar a gratis'}</button> ${e.freeMode ? '' : `<span class="muted">Precio por foto: $</span><input type="number" data-price="${e.id}" value="${Number(e.priceMxn || 20)}" min="1" max="5000" style="width:90px;display:inline-block"> <button data-saveprice="${e.id}">Guardar precio</button>`} <button data-rev="${e.id}">Revisar dorsales</button> <button data-del="${e.id}">Eliminar evento</button></p>`).join('') || '<p>Sin eventos.</p>'}</div>
    <div data-pg-controls="events"></div>
    ${joinedEvents.length ? `<h3>Eventos en los que participo</h3><p class="muted">Eventos de otros fotógrafos donde subes tus fotos a tu precio. El creador del evento maneja si es gratis o de pago.</p><div data-pg="joined">${joinedEvents.map(e => `<p><strong>${esc(e.name)}</strong> — ${e.photoCount || 0} foto(s) · ${e.freeMode ? 'Gratis' : 'De pago'} <span class="muted">Mi precio: $</span><input type="number" data-myprice="${e.id}" value="${Number(e.myPrice || e.priceMxn || 20)}" min="1" max="5000" style="width:90px;display:inline-block"> <button data-savemyprice="${e.id}">Guardar mi precio</button> <button data-leave="${e.id}">Salir del evento</button></p>`).join('')}</div><div data-pg-controls="joined"></div>` : ''}
    <div id="revList"></div>
    <p class="muted">Revisar dorsales muestra las fotos ya subidas de un evento: corrige el número o vuelve a leerlo con IA sin volver a subir la foto.</p>
    </section>
    <section data-tabpanel="ventas">
    <h3>Descargas y ventas</h3>
    <p>Total descargas: ${sales.totalDownloads} · Gratis: ${sales.freeDownloads} · Ingresos por ventas: $${sales.revenue} MXN</p>
    <div data-pg="sales">${sales.sales.map(s => `<p class="muted">${esc(s.eventName)} · Dorsal ${esc((s.bibs || []).join(', '))} · ${esc(s.buyerName)} · $${s.amount}</p>`).join('')}</div>
    <div data-pg-controls="sales"></div>
    </section>
    ${me.isOwner ? '' : `<section data-tabpanel="ganancias">
    <h3>Mis ganancias</h3>
    ${earningsHtml}
    </section>`}
    ${me.isOwner && payouts ? `<section data-tabpanel="fotografos">
    <h3>Mis ganancias</h3>
    ${earningsHtml}
    <h3>Pagos a fotógrafos</h3>
    <p class="muted">Todo el dinero cae en tu cuenta de Clip. Cada 72 horas desde la primera venta sin pagar, el pago se vence y sale en rojo. Mándale el dinero a su CLABE y luego marca "Pagado".</p>
    <p>Totales — Vendido: ${fmtMxn(payouts.totals.totalSold)} · Clip: ${fmtMxn(payouts.totals.clipFee)} · Tu comisión (10%): ${fmtMxn(payouts.totals.orlanFee)} · Para fotógrafos: ${fmtMxn(payouts.totals.photographerShare)} · Pendiente por pagar: ${fmtMxn(payouts.totals.pendingBalance)}</p>
    <div data-pg="payouts">${(payouts.photographers || []).length ? (payouts.photographers || []).map(p => `
    <div class="card">
      <p><strong>${esc(p.name)}</strong> ${p.approved ? '' : '<span class="error">(pendiente de aprobación)</span>'} · ${esc(p.email)}</p>
      <p class="muted">Vendido: ${fmtMxn(p.totalSold)} · Clip: ${fmtMxn(p.clipFee)} · Tu comisión: ${fmtMxn(p.orlanFee)} · Su parte: ${fmtMxn(p.photographerShare)}</p>
      <p><strong>Pendiente por pagarle: ${fmtMxn(p.pendingBalance)}</strong> ${p.pendingSince ? (p.isDue ? `<span class="error">● PAGO VENCIDO — vence desde ${String(p.dueAt || '').slice(0, 10)}</span>` : `<span class="muted">Próximo pago en ${p.hoursUntilDue} h</span>`) : '<span class="muted">Sin ventas pendientes.</span>'}</p>
      <p class="muted">CLABE para pagarle: ${p.payoutClabe ? `<strong>${esc(p.payoutClabe)}</strong> <button data-copyclabe="${esc(p.payoutClabe)}">Copiar CLABE</button>` : '<span class="error">El fotógrafo aún no pone su CLABE.</span>'}</p>
      ${p.lastPayout ? `<p class="muted">Último pago: ${fmtMxn(p.lastPayout.amountMxn)} el ${String(p.lastPayout.paidAt || '').slice(0, 10)}</p>` : ''}
      <button data-pay="${p.photographerId}" class="primary" ${p.pendingBalance > 0 ? '' : 'disabled'}>Marcar como pagado</button>
    </div>`).join('') : '<p class="muted">Todavía no hay otros fotógrafos.</p>'}</div>
    <div data-pg-controls="payouts"></div>
    ${(payoutHistory && payoutHistory.payouts && payoutHistory.payouts.length) ? `<p><strong>Historial de pagos enviados</strong></p><div data-pg="history">` + payoutHistory.payouts.map(h => `<p class="muted">${esc(h.photographerName)} · ${fmtMxn(h.amountMxn)} · ${String(h.paidAt || h.createdAt || '').slice(0, 10)}</p>`).join('') + `</div><div data-pg-controls="history"></div>` : ''}
    ${solicitudesHtml}
    <h3>Fotógrafos</h3>
    <p class="muted">Aprueba a los fotógrafos nuevos para que puedan crear eventos y vender. Solo tú ves esta lista.</p>
    <div data-pg="photogs">${(photographers && photographers.photographers && photographers.photographers.length) ? photographers.photographers.map(ph => `<p><strong>${esc(ph.name)}</strong> · ${esc(ph.email)} · ${ph.eventCount || 0} evento(s) · Vendido: ${fmtMxn(ph.totalSold)} · ${ph.isOwner ? '<span class="muted">Dueño</span>' : (ph.approved ? '<span class="ok">Aprobado</span>' : '<span class="error">Pendiente</span>')} ${(!ph.isOwner && !ph.hasApplication) ? '<span class="error">Sin solicitud</span>' : ''} ${ph.isOwner ? '' : (ph.approved ? `<button data-reject="${ph.id}">Quitar aprobación</button>` : `<button data-approve="${ph.id}" class="primary">Aprobar</button>`)}</p>`).join('') : '<p class="muted">No hay fotógrafos registrados.</p>'}</div>
    <div data-pg-controls="photogs"></div>
    </section>` : ''}
    <section data-tabpanel="estadisticas">
    <h3>Estadísticas</h3>
    ${(stats.totals.photoViews || stats.totals.eventViews || stats.totals.totalDownloads)
      ? `<p>Vistas de fotos: ${stats.totals.photoViews} · Visitantes únicos: ${stats.totals.uniqueViewers} · Visitas a eventos: ${stats.totals.eventViews} · Descargas: ${stats.totals.totalDownloads} · Ingresos: $${stats.totals.revenue} MXN</p>
    <div data-pg="statsevents">${(stats.events || []).map(e => `<p class="muted">${esc(e.name)} — Vistas: ${e.photoViews} · Visitantes: ${e.uniqueViewers} · Visitas al evento: ${e.eventViews} · Descargas: ${e.downloads} · $${e.revenue} MXN</p>`).join('')}</div>
    <div data-pg-controls="statsevents"></div>
    <p><strong>Fotos más vistas</strong></p>
    ${(stats.topPhotos || []).length ? (stats.topPhotos || []).map(p => `<p class="muted"><img src="/api/photo?id=${p.photoId}&thumb=1&inline=1" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:6px;vertical-align:middle"> Dorsal ${esc((p.bibs || []).join(', ') || 'sin dorsal')} · ${esc(p.eventName)} · ${p.views} vista(s) · ${p.downloads} descarga(s)</p>`).join('') : '<p class="muted">Sin vistas todavía.</p>'}
    <p><strong>Dorsales más buscados</strong></p>
    ${(stats.topBibs || []).length ? (stats.topBibs || []).map(b => `<p class="muted">Dorsal ${esc(b.bib)} · ${b.searches} búsqueda(s)</p>`).join('') : '<p class="muted">Sin búsquedas todavía.</p>'}`
      : '<p class="muted">Todavía no hay vistas registradas. Se empiezan a contar desde hoy.</p>'}
    </section>`;
  $('#evCreate').onclick = async () => {
    try { await api('/api/event-create', { method: 'POST', body: JSON.stringify({ name: $('#evName').value, sport: $('#evSport').value, eventDate: $('#evDate').value, location: $('#evPlace').value }) }); alert('Evento creado.'); loadPhotographer(); loadEvents(); } catch (e) { alert(e.message); }
  };
  $('#displaySave').onclick = async () => {
    try { const r = await api('/api/set-display-name', { method: 'POST', body: JSON.stringify({ displayName: $('#displayName').value }) }); me.displayName = r.displayName || ''; const shown = me.displayName || (me.name || '').split(' ')[0]; $('#displayStatus').textContent = 'Nombre guardado: tus fotos dirán "Foto de ' + shown + '".'; } catch (e) { $('#displayStatus').textContent = e.message; }
  };
  $('#tipSave').onclick = async () => {
    try { const r = await api('/api/set-tip', { method: 'POST', body: JSON.stringify({ clabe: $('#tipClabe').value }) }); me.tipClabe = r.tipClabe || ''; $('#tipStatus').textContent = 'CLABE guardada.'; } catch (e) { $('#tipStatus').textContent = e.message; }
  };
  // CLABE para recibir los pagos de las ventas (la pone el fotógrafo).
  const paySaveBtn = $('#paySave');
  if (paySaveBtn) paySaveBtn.onclick = async () => {
    try { const r = await api('/api/set-payout-clabe', { method: 'POST', body: JSON.stringify({ clabe: $('#payClabe').value }) }); me.payoutClabe = r.payoutClabe || ''; $('#payStatus').textContent = 'CLABE guardada.'; } catch (e) { $('#payStatus').textContent = e.message; }
  };
  // Dueño: copiar la CLABE del fotógrafo para pagarle.
  document.querySelectorAll('[data-copyclabe]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copyclabe); b.textContent = 'Copiado ✓'; setTimeout(() => { b.textContent = 'Copiar CLABE'; }, 2000); }
    catch (_) { alert('No se pudo copiar, cópiala a mano: ' + b.dataset.copyclabe); }
  });
  // Dueño: ya le mandó el dinero al fotógrafo — liquida su saldo.
  document.querySelectorAll('[data-pay]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.pay);
    const row = payouts && (payouts.photographers || []).find(p => p.photographerId === id);
    const amount = row ? fmtMxn(row.pendingBalance) : '';
    if (!confirm(`¿Ya le mandaste ${amount || 'el saldo pendiente'} a ${row ? row.name : 'este fotógrafo'}? Esto marca su saldo como pagado.`)) return;
    b.disabled = true;
    try { const r = await api('/api/payouts-mark-paid', { method: 'POST', body: JSON.stringify({ photographerId: id }) }); alert('Pago registrado: ' + fmtMxn(r.payout.amountMxn) + ' a ' + (r.payout.name || '') + ' (' + (r.downloadsSettled || 0) + ' venta(s)).'); loadPhotographer(); }
    catch (e) { alert(e.message); b.disabled = false; }
  });
  // Dueño: aprobar o quitar la aprobación de un fotógrafo.
  document.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
    try { await api('/api/approve-photographer', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.approve), approve: true }) }); alert('Fotógrafo aprobado. Ya puede crear eventos.'); loadPhotographer(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Quitarle la aprobación a este fotógrafo? Ya no podrá crear eventos ni subir fotos, pero sus eventos y ventas se quedan.')) return;
    try { await api('/api/approve-photographer', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.reject), approve: false }) }); alert('Aprobación quitada.'); loadPhotographer(); }
    catch (e) { alert(e.message); }
  });
  // Dueño: revisar solicitudes de fotógrafos (aprobar genera el link).
  document.querySelectorAll('[data-app-approve]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Aprobar a este fotógrafo y generarle su link de invitación?')) return;
    b.disabled = true;
    try { await api('/api/review-application', { method: 'POST', body: JSON.stringify({ id: Number(b.dataset.appApprove), decision: 'approved' }) }); alert('Fotógrafo aprobado. El link de invitación está en su tarjeta: cópialo o mándaselo por WhatsApp.'); loadPhotographer(); }
    catch (e) { alert(e.message); b.disabled = false; }
  });
  document.querySelectorAll('[data-app-reject]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Rechazar esta solicitud? El fotógrafo no podrá crear su cuenta con link.')) return;
    b.disabled = true;
    try { await api('/api/review-application', { method: 'POST', body: JSON.stringify({ id: Number(b.dataset.appReject), decision: 'rejected' }) }); loadPhotographer(); }
    catch (e) { alert(e.message); b.disabled = false; }
  });
  // Copiar el link de invitación de una solicitud aprobada.
  document.querySelectorAll('[data-copyinvite]').forEach(b => b.onclick = async () => {
    const a = apps.find(x => x.id === Number(b.dataset.copyinvite));
    if (!a) return;
    const url = location.origin + '/?invite=' + encodeURIComponent(a.inviteToken || '');
    try { await navigator.clipboard.writeText(url); b.textContent = 'Copiado ✓'; setTimeout(() => { b.textContent = 'Copiar link'; }, 2000); }
    catch (_) { alert('No se pudo copiar, cópialo a mano: ' + url); }
  });
  // Mandar el link de invitación por WhatsApp al solicitante.
  document.querySelectorAll('[data-app-wa]').forEach(b => b.onclick = () => {
    const a = apps.find(x => x.id === Number(b.dataset.appWa));
    if (!a) return;
    const digits = String(a.phone || '').replace(/\D/g, '');
    const waPhone = digits.length === 10 ? '52' + digits : digits;
    const url = location.origin + '/?invite=' + encodeURIComponent(a.inviteToken || '');
    const msg = `Hola ${a.name}, tu solicitud para ser fotógrafo de OnlyClick fue aprobada. Crea tu cuenta con este link: ${url}`;
    window.open('https://wa.me/' + waPhone + '?text=' + encodeURIComponent(msg), '_blank');
  });
  function renderCovPreview() { const ev = events.find(e => e.id === Number($('#covEvent').value)); $('#covPreview').innerHTML = ev && ev.coverPath ? `<img src="/api/cover?eventId=${ev.id}&t=${Date.now()}" alt="" style="width:100%;max-height:180px;object-fit:cover;border-radius:8px">` : '<p class="muted">Este evento aún no tiene portada.</p>'; }
  $('#covEvent').onchange = renderCovPreview;
  renderCovPreview();
  $('#covBtn').onclick = async () => {
    const file = $('#covFile').files[0];
    if (!file) { alert('Elige una foto para la portada.'); return; }
    $('#covStatus').textContent = 'Subiendo portada…';
    try {
      const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
      const small = await downscale(dataUrl, 1600);
      await api('/api/event-cover', { method: 'POST', body: JSON.stringify({ eventId: Number($('#covEvent').value), dataBase64: small.split(',')[1], mimeType: 'image/jpeg' }) });
      $('#covStatus').textContent = 'Portada guardada.';
      loadPhotographer(); loadEvents();
    } catch (e) { $('#covStatus').textContent = e.message; }
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
  function downscale(dataUrl, maxW, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, (maxW || 1200) / img.width);
        const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality || 0.85));
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
    $('#upStatus').textContent = 'Listas para subir — al terminar, los dorsales se leen solos con IA.';
    return;
  };
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
        // rápido y ocupa menos espacio en Supabase. Además se genera una
        // miniatura de 400px (~30-50 KB) para que la galería cargue rápido;
        // si falla, la subida sigue igual y la galería usa la foto completa.
        const small = await downscale(dataUrl, 1600);
        const b64 = small.split(',')[1];
        let thumbB64 = '';
        try {
          const thumb = await downscale(dataUrl, 400, 0.8);
          if (thumb && thumb.startsWith('data:image/jpeg') && thumb.length < small.length) thumbB64 = thumb.split(',')[1];
        } catch (_) {}
        const bibs = String(row.bibs || '').split(',').map(s => s.trim()).filter(Boolean);
        await api('/api/photo-upload', { method: 'POST', body: JSON.stringify({ eventId, filename: row.file.name, mimeType: 'image/jpeg', dataBase64: b64, thumbBase64: thumbB64, bibs, price: Number($('#upPrice').value || 0) }) });
        n++;
      } catch (_) { fails++; }
      $('#upStatus').textContent = 'Subiendo… ' + (n + fails) + '/' + files.length + (fails ? ' · ' + fails + ' fallaron' : '');
    });
    alert(n + ' foto(s) subida(s).' + (fails ? ' ' + fails + ' fallaron, inténtalas de nuevo.' : ''));
    loadPhotographer();
    // Al terminar de subirse, los dorsales se leen solos con IA, en
    // segundo plano, y se guardan. No se espera: la lectura sigue sola.
    if (n) autoReadBibsAfterUpload(eventId);
  };
  document.querySelectorAll('[data-free]').forEach(b => b.onclick = async () => {
    const ev = events.find(e => e.id === Number(b.dataset.free));
    await api('/api/set-free-mode', { method: 'POST', body: JSON.stringify({ eventId: ev.id, freeMode: !ev.freeMode }) });
    loadPhotographer(); loadEvents();
  });
  document.querySelectorAll('[data-saveprice]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.saveprice);
    const inp = document.querySelector(`[data-price="${id}"]`);
    try { await api('/api/set-event-price', { method: 'POST', body: JSON.stringify({ eventId: id, priceMxn: Number(inp.value) }) }); alert('Precio guardado: $' + inp.value + ' MXN por foto.'); loadPhotographer(); } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-savemyprice]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.savemyprice);
    const inp = document.querySelector(`[data-myprice="${id}"]`);
    try { await api('/api/set-my-event-price', { method: 'POST', body: JSON.stringify({ eventId: id, priceMxn: Number(inp.value) }) }); alert('Tu precio en este evento: $' + inp.value + ' MXN por foto.'); loadPhotographer(); } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-leave]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.leave);
    if (!confirm('¿Salir de este evento? Ya no podrás subir fotos ahí.')) return;
    try { await api('/api/leave-event', { method: 'POST', body: JSON.stringify({ eventId: id }) }); alert('Saliste del evento.'); loadPhotographer(); } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const ev = events.find(e => e.id === Number(b.dataset.del));
    if (!confirm(`¿Borrar el evento "${ev.name}" con sus ${ev.photoCount || 0} foto(s)? Se libera el espacio, pero no se puede deshacer.`)) return;
    try { const r = await api('/api/event-delete', { method: 'POST', body: JSON.stringify({ eventId: ev.id }) }); alert('Evento borrado. Se eliminaron ' + (r.photos || 0) + ' foto(s).'); loadPhotographer(); loadEvents(); } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-rev]').forEach(b => b.onclick = async () => {
    const ev = events.find(e => e.id === Number(b.dataset.rev));
    const box = $('#revList');
    box.innerHTML = '<p class="muted">Cargando fotos…</p>';
    try {
      const r = await api('/api/event-get?eventId=' + ev.id);
      box.innerHTML = '<h4>' + esc(r.event.name) + ' — ' + r.photos.length + ' foto(s)</h4><button id="batchRead" class="primary">Leer dorsales en lote (IA)</button> <span id="batchStatus" class="muted"></span>' + (r.photos.length > 100 ? '<p class="muted">Mostrando 100 de ' + r.photos.length + ' fotos — el lote procesa todas.</p>' : '') + r.photos.slice(0, 100).map(p => `
        <div class="row" style="align-items:center">
          <img src="/api/photo?id=${p.id}&thumb=1&inline=1" loading="lazy" decoding="async" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px">
          <input id="revBib-${p.id}" type="search" inputmode="numeric" autocomplete="one-time-code" placeholder="Dorsal" value="${esc((p.bibs || []).join(', '))}" style="max-width:130px">
          <button data-reread="${p.id}">Releer con IA</button>
          <button data-savebib="${p.id}">Guardar</button>
          <span id="revState-${p.id}" class="muted"></span>
        </div>`).join('');
      // Lote: lee con IA solo las fotos sin dorsal, de 3 en 3, y guarda cada
      // una en cuanto queda. Si se cierra la página, lo ya guardado queda y
      // al darle otra vez continúa con las que faltan.
      const batchBtn = document.getElementById('batchRead');
      if (batchBtn) batchBtn.onclick = async () => {
        if (!(r.photos || []).some(p => !(p.bibs || []).length)) { document.getElementById('batchStatus').textContent = 'Todas las fotos ya tienen dorsal.'; return; }
        batchBtn.disabled = true;
        const bStatus = (done, total, ok, none, err) => { const el = document.getElementById('batchStatus'); if (el) el.textContent = 'Leyendo… ' + done + '/' + total + ' · ✓ ' + ok + ' · sin dorsal ' + none + ' · errores ' + err; };
        const res = await batchReadBibs(r.photos, bStatus, (p, st2, list, errText) => {
          const st = document.getElementById('revState-' + p.id);
          if (st2 === 'ok') {
            const inp = document.getElementById('revBib-' + p.id); if (inp) inp.value = list.join(', ');
            if (st) st.textContent = '✓ IA';
          } else if (st2 === 'none') { if (st) st.textContent = 'Sin dorsal claro'; }
          else { if (st) st.textContent = errText; }
        });
        batchBtn.disabled = false;
        const el = document.getElementById('batchStatus'); if (el) el.textContent = 'Terminado: ' + res.ok + ' con dorsal, ' + res.none + ' sin dorsal claro, ' + res.err + ' con error. Si quedaron con error, dale otra vez al botón.';
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
  // Pestañas y paginación: se aplican después de cada render del panel.
  showPanelTab(panelTab);
  applyPanelPagination();
}

function showView(v) {
  // Un estado viejo del historial (versión anterior) puede traer una vista
  // que ya no existe ('search', 'photographer'): caer al inicio.
  if (!['home', 'events', 'myphotos', 'account', 'cart', 'notifications'].includes(v)) v = 'home';
  // Notificaciones es solo para fotógrafos (dueño incluido): cualquiera
  // más que intente abrirla (URL o clic) cae al inicio.
  if (v === 'notifications' && !(me && me.role === 'photographer')) v = 'home';
  ['home', 'events', 'myphotos', 'account', 'cart', 'notifications'].forEach(x => {
    const el = $('#view-' + x);
    if (el) el.classList.toggle('hidden', x !== v);
  });
  document.querySelectorAll('button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v !== currentView) { currentView = v; lastBackAtHome = 0; pushNav({ view: v }); }
  if (v === 'home') loadHome();
  if (v === 'events') loadEvents();
  if (v === 'myphotos') loadMyPhotos();
  if (v === 'cart') renderCartView();
  if (v === 'notifications') loadNotifications();
  if (v === 'account' && me && me.role === 'photographer') loadPhotographer();
}

// ---- Notificaciones: avisos del dueño a los fotógrafos ----
// El botón solo se ve si el usuario es fotógrafo (dueño incluido).
function updateNotificationsNav() {
  const show = !!(me && me.role === 'photographer');
  document.querySelectorAll('button[data-view="notifications"]').forEach(b => { b.style.display = show ? '' : 'none'; });
}
function updateNotifBadge(n) {
  ['notifCountTop', 'notifCountBottom'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(n || 0);
    el.classList.toggle('hidden', !n);
  });
}
// Conteo de no leídos al entrar con sesión de fotógrafo. Si el endpoint
// falla, no se rompe nada: el badge queda oculto.
async function refreshNotifBadge() {
  if (!me || me.role !== 'photographer') { updateNotifBadge(0); return; }
  try { const r = await api('/api/list-announcements'); updateNotifBadge(r.unreadCount || 0); }
  catch (_) { updateNotifBadge(0); }
}
async function loadNotifications() {
  const list = $('#notifList'), status = $('#notifStatus'), form = $('#notifForm');
  if (form) form.style.display = (me && me.isOwner) ? '' : 'none';
  try {
    const r = await api('/api/list-announcements');
    const items = r.announcements || [];
    list.innerHTML = items.length
      ? items.map(x => `<div class="card"><strong>${esc(x.title)}</strong><p>${esc(x.body).replace(/\n/g, '<br>')}</p><p class="muted">${esc(String(x.createdAt || '').slice(0, 10))}</p></div>`).join('')
      : '<p>No hay avisos todavía.</p>';
    if (status) status.textContent = '';
    // Al abrirlas ya se vieron: marcar leídas y limpiar el numerito.
    api('/api/mark-announcements-read', { method: 'POST', body: JSON.stringify({}) }).then(() => updateNotifBadge(0)).catch(() => {});
  } catch (e) {
    list.innerHTML = '';
    if (status) status.textContent = 'No se pudieron cargar los avisos. Intenta de nuevo.';
  }
}
async function publishAnnouncement() {
  const st = $('#notifFormStatus');
  const title = $('#notifTitle').value.trim();
  const body = $('#notifBody').value.trim();
  try {
    await api('/api/create-announcement', { method: 'POST', body: JSON.stringify({ title, body }) });
    $('#notifTitle').value = '';
    $('#notifBody').value = '';
    if (st) st.textContent = 'Aviso publicado a todos los fotógrafos.';
    loadNotifications();
  } catch (e) { if (st) st.textContent = e.message; }
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
  return currentView === 'home' && !lightboxPhoto && !(($('#eventDetail').innerHTML || '').trim());
}
function showExitToast() {
  const t = document.createElement('div');
  t.textContent = 'Pulsa atrás otra vez para salir de OnlyClick';
  t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#26262c;color:#fff;padding:10px 16px;border-radius:8px;z-index:99;font-size:15px';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
function guardHomeExit() {
  lastBackAtHome = Date.now();
  try { history.pushState({ view: 'home', homeGuard: true }, ''); } catch (_) {}
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
    } else { showView('home'); }
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
    applyNavState({ view: 'home' });
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

document.querySelectorAll('button[data-view]').forEach(b => b.onclick = () => showView(b.dataset.view));
const notifPublishBtn = $('#notifPublish');
if (notifPublishBtn) notifPublishBtn.onclick = publishAnnouncement;
$('#brandHome').onclick = () => showView('home');
$('#cartFab').onclick = () => showView('cart');
$('#lbCart').onclick = () => { if (lightboxPhoto) addToCart(lightboxPhoto); };
$('#bibSearch').onclick = searchBib;
$('#bibInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchBib(); });
$('#lbClose').onclick = () => closeLightbox();
$('#lbSave').onclick = () => { if (lightboxPhoto) savePhoto(lightboxPhoto, lightboxFreeMode, lightboxPriceMxn); };
// Si la URL trae ?invite=... (link de invitación aprobado por Orlan):
// se verifica y se prepara el registro como fotógrafo con ese token.
// Si el link ya no vale, se avisa y el registro normal sigue funcionando.
async function checkInvite() {
  inviteToken = new URLSearchParams(location.search).get('invite') || '';
  if (!inviteToken) return;
  const banner = $('#inviteBanner');
  try {
    const r = await api('/api/invite-status?token=' + encodeURIComponent(inviteToken));
    if (r.valid) {
      mode = 'register';
      $('#authTitle').textContent = 'Crear cuenta';
      $('#authSubmit').textContent = 'Crear mi cuenta';
      $('#authToggle').textContent = '¿Ya tienes cuenta? Iniciar sesión';
      $('#authName').style.display = '';
      $('#authRole').style.display = '';
      $('#authRole').value = 'photographer';
      updatePhotogNotice();
      if (banner) banner.innerHTML = `<p class="ok">Invitación de OnlyClick para ${esc(r.name)}: crea tu cuenta para unirte como fotógrafo.</p>`;
    } else {
      inviteToken = '';
      if (banner) banner.innerHTML = '<p class="error">Este link de invitación ya no es válido. Llena el formulario de fotógrafo en el inicio.</p>';
    }
  } catch (_) { /* sin conexión: el registro normal sigue funcionando */ }
  showView('account');
}

// Aviso al registrarse como fotógrafo sin invitación: primero el formulario del inicio.
function updatePhotogNotice() {
  var n = $('#photogNotice'); if (!n) return;
  var show = mode === 'register' && $('#authRole').value === 'photographer' && !inviteToken;
  n.style.display = show ? '' : 'none';
}
$('#authRole').onchange = updatePhotogNotice;
$('#authToggle').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; $('#authTitle').textContent = mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'; $('#authSubmit').textContent = mode === 'login' ? 'Entrar' : 'Crear mi cuenta'; $('#authToggle').textContent = mode === 'login' ? '¿No tienes cuenta? Crear cuenta' : '¿Ya tienes cuenta? Iniciar sesión'; $('#authName').style.display = mode === 'register' ? '' : 'none'; $('#authRole').style.display = mode === 'register' ? '' : 'none'; updatePhotogNotice(); };
$('#authSubmit').onclick = async () => {
  const body = { email: $('#authEmail').value, password: $('#authPass').value };
  try {
    let r;
    if (mode === 'register') { body.name = $('#authName').value; body.role = $('#authRole').value; if (inviteToken) body.inviteToken = inviteToken; r = await api('/api/auth-register', { method: 'POST', body: JSON.stringify(body) }); }
    else r = await api('/api/auth-login', { method: 'POST', body: JSON.stringify(body) });
    saveToken(r.token); await refreshAuth();
    // El link de invitación ya se usó: se quita de la URL.
    if (inviteToken) { inviteToken = ''; try { history.replaceState({}, '', location.pathname); } catch (_) {} }
    // El autocompletado de Chrome a veces deja el correo en el buscador
    // de dorsal al entrar: si parece correo, se limpia.
    const bibEl = $('#bibInput'); if (bibEl && bibEl.value.includes('@')) bibEl.value = '';
    showView('home');
  } catch (e) { $('#authMsg').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
};
$('#authForgot').onclick = () => { const box = $('#forgotBox'); box.style.display = box.style.display === 'none' ? '' : 'none'; };
$('#forgotSend').onclick = async () => {
  const email = $('#forgotEmail').value.trim();
  if (!email.includes('@')) { $('#forgotStatus').textContent = 'Escribe un correo válido.'; return; }
  $('#forgotStatus').textContent = 'Enviando…';
  try { await api('/api/password-forgot', { method: 'POST', body: JSON.stringify({ email }) }); $('#forgotStatus').textContent = 'Si el correo está registrado, te llegó un enlace para restablecer tu contraseña.'; }
  catch (e) { $('#forgotStatus').textContent = e.message; }
};
$('#resetSend').onclick = async () => {
  const pass = $('#resetPass').value;
  if (pass.length < 6) { $('#resetStatus').textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
  try {
    await api('/api/password-reset', { method: 'POST', body: JSON.stringify({ token: resetToken, password: pass }) });
    $('#resetStatus').textContent = 'Contraseña actualizada. Ya puedes entrar con la nueva.';
    $('#resetBox').style.display = 'none';
    history.replaceState({}, '', location.pathname);
  } catch (e) { $('#resetStatus').textContent = e.message; }
};

// Estado inicial en el historial para que la primera flecha de atrás no
// saque de la app.
try { history.replaceState({ view: 'home' }, ''); } catch (_) {}

// Si la URL trae ?reset=... (enlace del correo), mostrar el formulario
// de nueva contraseña aunque haya sesión iniciada.
resetToken = new URLSearchParams(location.search).get('reset') || '';
if (resetToken) {
  forceResetView = true;
  $('#resetBox').style.display = '';
  $('#forgotBox').style.display = 'none';
  $('#authTitle').textContent = 'Nueva contraseña';
}

refreshAuth();
loadHome();
handlePayReturn();
updateCartFab();
if (resetToken) showView('account');
checkInvite();
// Si la URL trae ?unirme=1 (link para mandar a un fotógrafo), abrir el
// inicio con el formulario "Soy fotógrafo, quiero unirme" ya desplegado.
if (new URLSearchParams(location.search).get('unirme')) goToPhotographerForm();
if (isInAppBrowser()) { const b = $('#inAppBanner'); if (b) b.style.display = ''; }
