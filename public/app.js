'use strict';
// OnlyClick — frontend (español). Sin frameworks.
// La descarga es una URL de mismo origen: /api/photo?id=... con
// Content-Disposition: attachment. En Chrome Android eso dispara el
// gestor de descargas real. NO es un blob URL ni navigator.share.
let token = localStorage.getItem('onlyclick_token') || '';
// Las etiquetas <img> NO mandan el header Authorization: el token de
// sesión va en la URL para que el dueño sí vea las fotos y portadas de
// sus álbumes ocultos (sin token el servidor responde 404 y la foto se
// ve negra). Sin sesión no se agrega nada: el álbum oculto sigue
// invisible para los demás.
// El token TAMBIÉN rompe el caché del edge: la clave de caché es la URL
// completa, así que con token cada usuario tiene URLs distintas y Vercel
// vuelve a bajar la foto en cada vista (eso se comió los 7.52 GB de
// Fast Origin Transfer). Por eso el token solo se pone cuando hace falta
// (needsToken): álbum oculto. En eventos visibles no aporta nada, porque
// el servidor ya las sirve sin sesión. Por default se deja el token
// (comportamiento viejo, seguro); solo los sitios que SABEN que el
// evento es visible pasan needsToken=false.
function imgToken() { return token ? '&token=' + encodeURIComponent(token) : ''; }
function photoImgUrl(id, thumb, needsToken) { return '/api/photo?id=' + id + (thumb ? '&thumb=1' : '') + '&inline=1' + (needsToken === false ? '' : imgToken()); }
function coverImgUrl(eventId, needsToken) { return '/api/cover?eventId=' + eventId + (needsToken === false ? '' : imgToken()); }
let me = null;
let mode = 'login'; // login | register
let resetToken = ''; // ?reset=... del enlace que llega por correo
let inviteToken = ''; // ?invite=... del link de invitación aprobado
let currentEvent = null;
let currentEventName = ''; // nombre del evento abierto (para el modal de búsqueda y compartir)
let currentTipClabe = '';
let currentTipName = '';
let currentPhotos = [];
let latestEventId = null; // evento más reciente CON fotos (el del hero): ahí busca la selfie/dorsal del inicio; null = búsqueda global
let latestEventName = '';
let homeEvents = []; // eventos CON fotos para el selector de carrera del modal de búsqueda (más reciente primero)
let lightboxPhoto = null;
let lightboxFreeMode = true;
let lightboxPriceMxn = 0;
let currentEventHidden = false; // ¿el evento abierto es oculto? (para el token de la foto ampliada)
let payReturnHandled = false; // regreso desde Clip ya procesado (no abrir links profundos encima)
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

// Panel en lista: el inicio del panel es una lista de filas (se arma en
// loadPhotographer); al picar una fila se abre esa sección y arriba sale
// "‹ Panel fotógrafo" para volver a la lista. showPanelTab abre una
// sección (esconde la lista y muestra el botón de volver); showPanelHome
// vuelve a la lista (esconde todas las secciones).
function showPanelTab(tab) {
  panelTab = tab;
  document.querySelectorAll('#photoPanel [data-tabpanel]').forEach(s => s.classList.toggle('hidden', s.dataset.tabpanel !== tab));
  const home = document.getElementById('panelListHome');
  if (home) home.classList.add('hidden');
  const back = document.getElementById('panelBack');
  if (back) back.classList.remove('hidden');
}
function showPanelHome() {
  document.querySelectorAll('#photoPanel [data-tabpanel]').forEach(s => s.classList.add('hidden'));
  const home = document.getElementById('panelListHome');
  if (home) home.classList.remove('hidden');
  const back = document.getElementById('panelBack');
  if (back) back.classList.add('hidden');
}

// Fila de un evento en "Mis eventos": al picarla se despliegan sus
// controles debajo (precio, dorsales, ocultar, eliminar) y se puede
// volver a cerrar; los demás eventos quedan cerrados.
function toggleEventRow(btn) {
  const row = btn.closest('.sec-ev');
  if (!row) return;
  const body = row.querySelector('.sec-ev-body');
  if (!body) return;
  body.classList.toggle('hidden');
  const open = !body.classList.contains('hidden');
  row.classList.toggle('open', open);
  const chev = row.querySelector('.sec-chev');
  if (chev) chev.textContent = open ? '⌃' : '›';
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
// ---- Carrito por cuenta (no por teléfono) ----
// Antes el carrito vivía en UNA sola clave de localStorage
// ('onlyclick_cart'): al salir de la cuenta de deportista y entrar
// como fotógrafo (o sin sesión) seguían apareciendo las mismas fotos.
// Ahora cada cuenta tiene su propio carrito y el invitado (sin sesión)
// tiene el suyo. El pago pendiente NO vive en el carrito: se consulta
// al servidor (checkout-status), así que cambiar la clave no afecta
// ningún pago en proceso.
const LEGACY_CART_KEY = 'onlyclick_cart';
const GUEST_CART_KEY = 'onlyclick_cart_guest';
function cartKeyFor(user) { return user && user.id ? 'onlyclick_cart_u_' + Number(user.id) : GUEST_CART_KEY; }
function activeCartKey() { return cartKeyFor(me); }
let cartKey = activeCartKey();
let cart = loadCart(cartKey);
function readCartItems(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(x => x && Number(x.id)) : [];
  } catch (_) { return []; }
}
function loadCart(key) { return readCartItems(key || activeCartKey()); }
function saveCart() {
  try { localStorage.setItem(cartKey, JSON.stringify(cart)); } catch (_) {}
  updateCartBadge();
}
// Une dos listas de fotos sin repetir por id (la base manda).
function mergeCartItems(base, extra) {
  const seen = new Set(base.map(x => Number(x.id)));
  const out = base.slice();
  for (const it of extra) { if (!seen.has(Number(it.id))) { seen.add(Number(it.id)); out.push(it); } }
  return out;
}
// Migración única de la clave vieja ('onlyclick_cart'): sus fotos
// pasan a la clave activa (la del usuario si hay sesión, la de
// invitado si no) y la clave vieja se borra. Idempotente: sin clave
// vieja no hace nada.
function migrateLegacyCart() {
  const legacy = readCartItems(LEGACY_CART_KEY);
  if (legacy.length) {
    const key = activeCartKey();
    try { localStorage.setItem(key, JSON.stringify(mergeCartItems(readCartItems(key), legacy))); } catch (_) {}
  }
  try { localStorage.removeItem(LEGACY_CART_KEY); } catch (_) {}
}
// Al entrar con sesión, lo que el invitado agregó pasa al carrito del
// usuario (sin duplicar) y el carrito de invitado queda vacío. Así se
// conserva el flujo "veo fotos sin entrar y luego entro a pagar" y el
// del carrito compartido (que agrega al carrito activo).
function mergeGuestCartIntoUser() {
  if (!me || !me.id) return;
  const guest = readCartItems(GUEST_CART_KEY);
  if (!guest.length) return;
  const key = cartKeyFor(me);
  try { localStorage.setItem(key, JSON.stringify(mergeCartItems(readCartItems(key), guest))); } catch (_) {}
  try { localStorage.removeItem(GUEST_CART_KEY); } catch (_) {}
}
// Cambia el carrito activo según quién tiene la sesión: migra la clave
// vieja, fusiona el carrito de invitado si se entró con sesión, carga
// el carrito de la cuenta, actualiza el numerito y vuelve a pintar la
// vista del carrito si está abierta.
function setActiveCart() {
  try { migrateLegacyCart(); } catch (_) {}
  try { mergeGuestCartIntoUser(); } catch (_) {}
  cartKey = activeCartKey();
  cart = loadCart(cartKey);
  updateCartBadge();
  if (currentView === 'cart') renderCartView();
}
function singleDiscountForPosition(pos) {
  for (const t of SINGLE_TIERS) if (pos >= t.from && pos <= t.to) return t.discount;
  return 0;
}
// Reparte `total` en n partes enteras que suman exactamente total.
function splitAmount(total, n) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const rem = cents - base * n;
  const out = [];
  for (let i = 0; i < n; i++) out.push((base + (i < rem ? 1 : 0)) / 100);
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
    const total = Math.round(subtotal * (1 - PACKAGE_DISCOUNT) * 100) / 100;
    packages.push({ photoIds: group.map(g => g.id), subtotal, discount: subtotal - total, total, amounts: splitAmount(total, group.length) });
  }
  const singles = sorted.slice(numPackages * PACKAGE_SIZE);
  const lines = singles.map((it, i) => {
    const price = Math.round(Number(it.priceMxn || it.price || 0) * 100) / 100;
    const discount = singleDiscountForPosition(i + 1);
    return { id: it.id, price, discount, lineTotal: Math.round(price * (1 - discount) * 100) / 100 };
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
  const packageTotal = Math.round((currentSum + missing * maxPrice) * (1 - PACKAGE_DISCOUNT) * 100) / 100;
  return { missing, packageTotal };
}
function cartHas(id) { return cart.some(x => x.id === Number(id)); }
function updateCartBadge() {
  const badge = $('#cartCount');
  if (!badge) return;
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
function addToCart(photo, silent) {
  const freeMode = photo.freeMode !== false;
  if (freeMode || photo.owned) return false;
  if (cartHas(photo.id)) { if (!silent) showView('cart'); return false; } // ya está: ir al carrito
  cart.push({ id: photo.id, eventId: photo.eventId, eventName: photo.eventName || '', priceMxn: Number(photo.priceMxn || photo.price || 0), bibs: (photo.bibs || []).slice() });
  saveCart();
  document.querySelectorAll(`[data-cart="${photo.id}"]`).forEach(b => { b.textContent = 'En el carrito ✓'; b.disabled = true; });
  const lb = $('#lbCart');
  if (lb && Number(lb.dataset.cart) === photo.id) { lb.textContent = 'En el carrito ✓'; lb.disabled = true; }
  if (!silent) showToast('Foto agregada al carrito (' + cart.length + ').');
  return true;
}
function removeFromCart(id) {
  cart = cart.filter(x => x.id !== Number(id));
  saveCart();
  document.querySelectorAll(`[data-cart="${id}"]`).forEach(b => { b.textContent = 'Agregar al carrito'; b.disabled = false; });
  const lb = $('#lbCart');
  // En la vista ampliada el botón lleva el precio ("Agregar al carrito ·
  // $20 MXN"): al quitarla se restaura con su precio, no en blanco.
  if (lb && Number(lb.dataset.cart) === Number(id)) { lb.textContent = (lightboxPhoto && lightboxPhoto.id === Number(id) && lightboxPriceMxn) ? 'Agregar al carrito · $' + lightboxPriceMxn + ' MXN' : 'Agregar al carrito'; lb.disabled = false; }
}
function clearCart() { cart = []; saveCart(); }

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// timeoutMs (opcional): si el servidor no contesta en ese tiempo, la
// llamada falla en vez de quedarse colgada para siempre. Solo lo usan
// las llamadas que no pueden esperar (panel, sesión); las subidas y la
// lectura de dorsales no llevan límite.
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const { timeoutMs, ...fetchOpts } = opts;
  let ctrl, timer;
  if (timeoutMs) { ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), timeoutMs); }
  try {
    const res = await fetch(path, { ...fetchOpts, headers, ...(ctrl ? { signal: ctrl.signal } : {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Error del servidor.');
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('El servidor tardó demasiado en responder.');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    const s = await api('/api/auth-status', { timeoutMs: 10000 });
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
      closeUserMenu();
    }
  } catch (e) {
    // Si el servidor no contesta, el encabezado igual debe tener con
    // qué entrar: antes quedaba sin botón de cuenta (así lo vio Orlan
    // en su teléfono) y sin campanita. El clic lo atiende el manejador
    // de #session (abajo, junto al inicio de la app).
    $('#authMsg').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    updateNotificationsNav();
    updateNotifBadge(0);
    const sessionEl = $('#session');
    if (sessionEl && !sessionEl.innerHTML.trim()) sessionEl.innerHTML = `<button id="loginBtn" class="ghost">Entrar</button>`;
  }
  // La sesión ya se resolvió (o no hay): el carrito activo es el de
  // esta cuenta (o el de invitado). Nunca debe romper el inicio.
  try { setActiveCart(); } catch (_) {}
}

function doLogout() { saveToken(''); me = null; setActiveCart(); location.reload(); }

// Menú del avatar (header): saludo + accesos + cerrar sesión. El logo
// nunca choca con ningún botón: aquí solo hay un círculo.
function renderUserMenu() {
  const m = $('#userMenu');
  if (!me) { m.innerHTML = ''; m.classList.add('hidden'); return; }
  m.innerHTML = `<div class="um-name">Hola, ${esc(me.name)}</div>
    <div class="um-sub">${esc(me.email)} · ${me.role === 'photographer' ? 'Fotógrafo' : 'Deportista'}</div>
    ${me.role === 'photographer' ? '<button id="umPanel">Panel fotógrafo</button>' : ''}
    <button id="umLogout">Cerrar sesión</button>`;
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

// ---- Compartir: carrito y foto suelta (idea de ZebraSnap) ----
// El carrito se comparte con un link (?carrito=id,id,...): quien lo abre
// ve las fotos en solo lectura y puede agregarlas a SU carrito para
// comprarlas. Los precios se recalculan en vivo en el servidor (el link
// solo lleva ids, nunca precios). Si una foto ya no existe, se avisa y
// se muestran las demás. El link caduca junto con el álbum: si el evento
// ya pasó sus 60 días, esas fotos se reportan como caducadas (decisión de
// Orlan 2026-11-17) y el link ya no muestra nada de ese álbum. Una foto
// suelta se comparte con
// /?event=..&photo=.. y se abre en la vista ampliada; desde ahí el amigo
// busca las suyas por dorsal o selfie. Las fotos de eventos gratis se
// comparten igual, solo para verlas (para guardarlas hay que entrar).
async function shareLink(url, text) {
  // Compartir nativo del teléfono; si se cancela, no hacer nada más.
  // Si no hay compartir nativo, copiar el link; si tampoco se puede,
  // abrir WhatsApp con el texto ya escrito.
  try {
    if (navigator.share) { await navigator.share({ title: 'OnlyClick', text, url }); return 'shared'; }
    throw new Error('no-share');
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
    try { await navigator.clipboard.writeText(url); return 'copied'; }
    catch (_) { window.open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + url), '_blank'); return 'whatsapp'; }
  }
}
function shareCart() {
  if (!cart.length) return;
  const url = location.origin + '/?carrito=' + cart.map(x => x.id).join(',');
  const st = $('#cartShareStatus');
  shareLink(url, 'Te comparto mis fotos de OnlyClick').then(r => {
    if (!st) return;
    if (r === 'copied') st.textContent = 'Link copiado: ' + url;
    else if (r === 'whatsapp') st.textContent = 'Se abrió WhatsApp con el link listo.';
    else if (r === 'shared') st.textContent = 'Carrito compartido.';
  });
}
function sharePhoto(p) {
  const eventId = p.eventId || currentEvent || '';
  const url = location.origin + '/?event=' + eventId + '&photo=' + p.id;
  shareLink(url, 'Mira mi foto en OnlyClick').then(r => {
    if (r === 'copied') showToast('Link de la foto copiado.');
    else if (r === 'whatsapp') showToast('Se abrió WhatsApp con el link listo.');
  });
}
async function handleSharedCart(ids) {
  showView('home');
  const box = $('#sharedBox');
  if (!box) return;
  box.innerHTML = '<div class="card"><p>Cargando las fotos que te compartieron…</p></div>';
  try {
    const r = await api('/api/shared-cart?ids=' + ids.map(encodeURIComponent).join(','));
    const missing = r.missing || [];
    const expired = r.expired || [];
    currentPhotos = r.photos;
    const paid = r.photos.filter(p => p.freeMode === false && !p.owned);
    const free = r.photos.filter(p => p.freeMode !== false);
    box.innerHTML = `<div class="card"><h3>Fotos que te compartieron</h3>
      <p class="muted">${r.photos.length} foto(s) para ti. ${paid.length ? 'Agrégalas a tu carrito y págalas con tarjeta.' : ''}${free.length ? ' Las gratis se guardan desde cada foto.' : ''}${missing.length ? ` ${missing.length} foto(s) ya no están disponibles.` : ''}${expired.length ? ` ${expired.length} foto(s) ya caducaron con su álbum (los álbumes se borran 60 días después del evento).` : ''}</p>
      ${!r.photos.length && expired.length ? `<p>El álbum de esas fotos ya caducó y se borró, por eso el link ya no muestra nada. Pídele a quien te lo mandó que te comparta fotos de un evento vigente.</p>` : ''}
      ${paid.length ? `<div class="row"><button id="sharedAddAll" class="primary">Agregar todo a mi carrito</button></div><p id="sharedAddStatus" class="muted"></p>` : ''}
      <div class="grid" style="margin-top:12px">${r.photos.map(p => photoCard(p)).join('') || '<p>No hay fotos para mostrar.</p>'}</div></div>`;
    bindPhotos(r.photos);
    const addAll = $('#sharedAddAll');
    if (addAll) addAll.onclick = () => {
      let n = 0;
      paid.forEach(p => { if (addToCart(p, true)) n++; });
      const st = $('#sharedAddStatus');
      if (st) st.textContent = n ? n + ' foto(s) agregadas a tu carrito.' : 'Esas fotos ya estaban en tu carrito.';
      showToast(n ? n + ' foto(s) en tu carrito.' : 'Ya estaban en tu carrito.');
    };
  } catch (e) {
    box.innerHTML = `<div class="card"><h3>Fotos que te compartieron</h3><p class="error">No se pudieron cargar: ${esc(e.message)}</p></div>`;
  }
}
// Links profundos: ?carrito=.. (carrito compartido) y ?event=..&photo=..
// (foto compartida). No se procesan si la URL viene de un regreso de
// pago de Clip (eso lo maneja handlePayReturn).
async function handleDeepLinks() {
  const q = new URLSearchParams(location.search);
  const carrito = q.get('carrito');
  if (carrito) {
    const ids = carrito.split(',').map(s => Number(s)).filter(n => Number.isFinite(n) && n > 0);
    if (ids.length) { await handleSharedCart(ids); return; }
  }
  const eventId = Number(q.get('event') || 0), photoId = Number(q.get('photo') || 0);
  if (eventId && !payReturnHandled) {
    await loadEventDetail(eventId);
    if (photoId) {
      const p = currentPhotos.find(x => x.id === photoId);
      if (p) openLightbox(p);
    }
  }
}

// ---- Regreso desde Clip (pago) ----
// Clip redirige a /api/checkout-return, que verifica con Clip y nos
// devuelve aquí con ?event=&photo=&paid=1 | pay=pending | pay=failed.
async function handlePayReturn() {
  const q = new URLSearchParams(location.search);
  const paid = q.get('paid'), pay = q.get('pay');
  if (paid || pay) payReturnHandled = true;
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
    alert('Tu pago está en proceso. En cuanto Clip lo confirme, la foto aparecerá en "Mis fotos".');
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
      <img src="${photoImgUrl(pkg.photoIds[0], true)}" alt="" loading="lazy">
      <div class="cart-info"><strong>Paquete de 10 fotos</strong><span class="muted">Dorsales: ${esc(bibs)}${first && first.eventName ? ' · ' + esc(first.eventName) : ''}</span></div>
      <div class="cart-price"><s class="muted">$${pkg.subtotal}</s> <strong>$${pkg.total} MXN</strong> <span class="badge">-25%</span></div>
      <button data-rmpackage="${pi}" class="secondary">Quitar paquete</button>
    </div>`;
  }).join('');
  const singleRows = t.lines.map(l => {
    const it = byId[l.id];
    return `<div class="cart-row">
      <img src="${photoImgUrl(it.id, true)}" alt="" loading="lazy">
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
    <div class="row"><button id="cartShare" class="secondary">Compartir carrito</button></div>
    <p id="cartShareStatus" class="muted"></p>
    <p class="muted">Pagas una sola vez con Clip, con tarjeta de crédito o débito (la confirmación es al instante).</p>
    <div class="pay-methods">
      <div class="pay-row"><span>💳 Tarjeta de crédito o débito</span><span class="ok">Disponible</span></div>
      <div class="pay-row pay-disabled"><span>💵 Efectivo en OXXO</span><span class="muted">No disponible por el momento</span></div>
    </div></div>`;
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
  const cartShareBtn = $('#cartShare');
  if (cartShareBtn) cartShareBtn.onclick = shareCart;
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
      box.innerHTML = '<p>Tu pago está en proceso. En cuanto Clip lo confirme, las fotos aparecerán en "Mis fotos".</p><div class="row"><button id="cartVerify" class="secondary">Verificar pago</button></div>';
      const cv = $('#cartVerify');
      if (cv) cv.onclick = () => verifyCartPayment(pid, cv);
      pollCartPayment(pid);
      return;
    } catch (_) {
      box.innerHTML = '<p>No se pudo verificar el pago todavía. Revisa "Mis fotos" en unos minutos.</p><div class="row"><button id="cartVerify" class="secondary">Verificar pago</button></div>';
      const cv = $('#cartVerify');
      if (cv) cv.onclick = () => verifyCartPayment(pid, cv);
      return;
    }
  }
  if (pay === 'pending') {
    alert('Tu pago está en proceso. En cuanto Clip lo confirme, las fotos aparecerán en "Mis fotos".');
    const box2 = $('#cartBox');
    if (box2) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<button id="cartVerify" class="secondary">Verificar pago</button>';
      box2.appendChild(row);
      const cv = $('#cartVerify');
      if (cv) cv.onclick = () => verifyCartPayment(pid, cv);
    }
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

// Borrar foto: solo el fotógrafo dueño de la foto (o el dueño de
// OnlyClick, que puede borrar cualquier foto). Espejo del backend
// (isPhotoOwner): si la foto no trae photographerId (fotos viejas),
// se usa el fotógrafo del evento que se pasa en opts.event.
function canDeletePhoto(p, ev) {
  if (!me || me.role !== 'photographer') return false;
  if (me.isOwner) return true;
  if (p && p.photographerId != null) return Number(p.photographerId) === me.id;
  return !!ev && Number(ev.photographerId) === me.id;
}

function photoCard(p, opts) {
  const freeMode = p.freeMode !== false;
  const price = Number(p.priceMxn || p.price || 0);
  const bibs = (p.bibs || []).map(b => `<span class="badge">Dorsal ${esc(b)}</span>`).join('');
  // Token en la URL solo si el evento es oculto (o no se sabe el evento):
  // en eventos visibles la foto se sirve sin sesión y sin token el edge
  // de Vercel la guarda en caché y la sirve más rápido.
  const needsToken = opts && opts.event ? !!opts.event.isHidden : true;
  // Cuenta atrás de caducidad: solo llega en Mis fotos (listPurchases
  // pone expiresAt). Cuando faltan 15 días o menos, la foto avisa
  // "Se borra en N días" y el número baja solo cada día.
  const daysLeft = p.expiresAt ? Math.ceil((new Date(p.expiresAt).getTime() - Date.now()) / (24 * 3600 * 1000)) : null;
  return `<div class="photo">
    <div class="thumb-wrap"><img src="${photoImgUrl(p.id, true, needsToken)}" loading="lazy" decoding="async" alt="Foto dorsal ${(p.bibs || []).join(', ')}" data-open="${p.id}">${freeMode ? '' : `<span class="price-pill">$${price} MXN</span>`}</div>
    <div class="meta">${bibs || '<span class="muted">Sin dorsal</span>'}
      ${freeMode ? '<span class="badge free">Gratis</span>' : `<span class="badge">$${price} MXN</span>`}
      ${p.owned ? '<span class="badge owned">Tuya</span>' : ''}
      ${daysLeft != null && daysLeft >= 1 && daysLeft <= 15 ? `<span class="badge warn">Se borra en ${daysLeft} día${daysLeft === 1 ? '' : 's'}</span>` : ''}
      ${p.photographerName ? `<span class="muted">Foto de ${esc(p.photographerName)}</span>` : ''}
      <button data-save="${p.id}" class="primary">${freeMode ? 'Guardar gratis' : (p.owned ? 'Guardar' : 'Pagar y descargar · $' + price + ' MXN')}</button>
      ${!freeMode && !p.owned ? `<button data-cart="${p.id}" class="secondary cart-btn" ${cartHas(p.id) ? 'disabled' : ''}>${cartHas(p.id) ? 'En el carrito ✓' : 'Agregar al carrito'}</button>` : ''}
      ${p._pending ? `<button data-verify="${p.id}" class="secondary">Verificar pago</button>` : ''}
      ${opts && opts.remove && Number(p.amount || 0) === 0 ? `<button data-remove="${p.id}" class="secondary">Quitar de Mis fotos</button>` : ''}
      ${opts && opts.delete && canDeletePhoto(p, opts.event) ? `<button data-delete="${p.id}" class="secondary">Eliminar foto</button>` : ''}
    </div></div>`;
}

// Vista ampliada (lightbox): se abre al picar una foto de la cuadrícula
// o al entrar con un link compartido (/?event=..&photo=..). Aquí vive
// todo lo de la foto ampliada: qué incluye, detalles (archivo,
// resolución, tamaño), compartir, y el botón del carrito con su precio.
function openLightbox(p) {
  lightboxPhoto = p;
  trackView('photo', p.id, p.eventId || null);
  const freeMode = p.freeMode !== false;
  const price = Number(p.priceMxn || p.price || 0);
  lightboxFreeMode = freeMode;
  lightboxPriceMxn = price;
  // Token en la vista ampliada: hace falta cuando los bytes dependen
  // de quién mira — álbum oculto (solo el dueño) o evento de PAGO (el
  // que compró ve el original, el que no compró ve la miniatura; sin
  // token el servidor no sabe quién eres y al comprador le saldría la
  // miniatura chica en vez del original). En evento gratis y visible no
  // hace falta: la foto es igual para todos y sin token el edge la
  // guarda en caché. Si no se sabe el evento, se deja el token (seguro).
  const lbNeedsToken = (p.eventId != null && Number(p.eventId) === Number(currentEvent)) ? (currentEventHidden || !freeMode) : true;
  $('#lbImg').src = photoImgUrl(p.id, false, lbNeedsToken);
  $('#lbInfo').textContent = `Dorsal: ${(p.bibs || []).join(', ') || 'sin dorsal'} · ${freeMode ? 'Descarga gratis' : '$' + price + ' MXN'}` + (p.photographerName ? ` · Foto de ${p.photographerName}` : '');
  $('#lbSave').textContent = freeMode ? 'Guardar gratis' : (p.owned ? 'Guardar' : 'Pagar y descargar · $' + price + ' MXN');
  $('#lbSave').dataset.save = p.id;
  // En el navegador de Facebook/Instagram: botón para abrir la foto
  // en una pestaña nueva (ahí se puede guardar con pulsación larga).
  const lbOpen = $('#lbOpen');
  lbOpen.style.display = isInAppBrowser() ? '' : 'none';
  lbOpen.onclick = () => { window.open(photoImgUrl(p.id, false, lbNeedsToken), '_blank'); };
  // Botón del carrito en la vista ampliada: solo fotos de pago sin comprar.
  const lbCart = $('#lbCart');
  lbCart.style.display = (!freeMode && !p.owned) ? '' : 'none';
  lbCart.dataset.cart = p.id;
  lbCart.disabled = cartHas(p.id);
  lbCart.textContent = cartHas(p.id) ? 'En el carrito ✓' : 'Agregar al carrito · $' + price + ' MXN';
  // "Verificar pago" en la vista ampliada: solo foto de pago sin
  // comprar y con un pago pendiente del usuario (se pregunta una vez
  // al abrir, con la rama {photoIds} que lee el estado local).
  const lbVerify = $('#lbVerify');
  if (lbVerify) {
    lbVerify.style.display = 'none';
    lbVerify.onclick = () => verifyPhotoPayment(p.id, lbVerify);
    if (!freeMode && !p.owned && token) {
      api('/api/checkout-status', { method: 'POST', body: JSON.stringify({ photoIds: [p.id] }) }).then(s => {
        if (lightboxPhoto !== p) return;
        const st = (s.photos || [])[0];
        if (st && st.status === 'pending') lbVerify.style.display = '';
      }).catch(() => {});
    }
  }
  // Borrar foto en la vista ampliada: solo el dueño de la foto. Aquí
  // no siempre se conoce el evento, así que sin photographerId solo el
  // dueño de OnlyClick la ve (en la cuadrícula del evento sí se usa el
  // fotógrafo del evento como respaldo).
  const lbDelete = $('#lbDelete');
  if (lbDelete) {
    lbDelete.style.display = canDeletePhoto(p, null) ? '' : 'none';
    lbDelete.onclick = () => deletePhotoFlow(p.id);
  }
  // Lo que incluye + detalles (archivo, dorsal, fotógrafo, evento,
  // resolución y tamaño cuando se conocen).
  const inc = $('#lbIncludes');
  if (inc) inc.innerHTML = `<strong>Lo que incluye</strong><br>✓ Descarga inmediata<br>✓ Alta resolución${freeMode ? '' : '<br>✓ Sin marca de agua'}<br>✓ Uso personal`;
  const det = $('#lbDetails');
  if (det) {
    const detBase = `<strong>Detalles</strong><br>Archivo: ${esc(p.filename || ('onlyclick-foto-' + p.id + '.jpg'))}<br>Dorsal: ${esc((p.bibs || []).join(', ') || 'sin dorsal')}` + (p.photographerName ? `<br>Foto de ${esc(p.photographerName)}` : '') + (p.eventName ? `<br>Evento: ${esc(p.eventName)}` : '');
    const metaLine = () => {
      if (p.widthPx && p.heightPx) return `<br>Resolución: ${p.widthPx} × ${p.heightPx} px` + (p.sizeKb ? `<br>Tamaño: ${p.sizeKb >= 1024 ? (p.sizeKb / 1024).toFixed(1) + ' MB' : p.sizeKb + ' KB'}` : '');
      return '<br>Resolución: —';
    };
    det.innerHTML = detBase + metaLine();
    // Si la foto no trae resolución/tamaño (fotos viejas), se piden una
    // vez y se rellenan al llegar; si falla, queda el "—".
    if (!p.widthPx || !p.heightPx || !p.sizeKb) {
      api('/api/photo-meta?id=' + p.id).then(m => {
        if (lightboxPhoto !== p) return;
        if (m.widthPx) p.widthPx = m.widthPx;
        if (m.heightPx) p.heightPx = m.heightPx;
        if (m.sizeKb) p.sizeKb = m.sizeKb;
        det.innerHTML = detBase + metaLine();
      }).catch(() => {});
    }
  }
  const lbShare = $('#lbShare');
  if (lbShare) lbShare.onclick = () => sharePhoto(p);
  // Marca de agua en la vista previa de pago: el servidor ya sirve la
  // miniatura en vez del original; este texto va encima.
  $('#lbWm').style.display = (!freeMode && !p.owned) ? 'flex' : 'none';
  $('#lightbox').style.display = 'flex';
  lightboxPushed = true;
  lastBackAtHome = 0;
  pushNav({ view: currentView, lightbox: p.id });
}

// Borrar una foto del álbum: pregunta primero y, si se confirma, la
// borra en el servidor y saca la tarjeta de la vista sin recargar la
// página. Si la foto ya se vendió, el servidor la bloquea (400) y se
// muestra el motivo. Una foto a la vez.
async function deletePhotoFlow(photoId) {
  if (!confirm('¿Eliminar esta foto? No se puede deshacer.')) return;
  try {
    await api('/api/photo-delete', { method: 'POST', body: JSON.stringify({ photoId }) });
    const btn = document.querySelector(`[data-delete="${photoId}"]`);
    if (btn) { const card = btn.closest('.photo'); if (card) card.remove(); }
    const i = currentPhotos.findIndex(x => x.id === photoId);
    if (i >= 0) currentPhotos.splice(i, 1);
    if (lightboxPhoto && lightboxPhoto.id === photoId) hideLightbox();
    const grid = document.querySelector('#evGrid');
    if (grid && !grid.querySelector('.photo')) grid.innerHTML = '<p>No hay fotos todavía.</p>';
  } catch (e) { alert(e.message || 'No se pudo eliminar la foto.'); }
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
    if (p) openLightbox(p);
  });
  document.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => deletePhotoFlow(Number(b.dataset.delete)));
  document.querySelectorAll('[data-verify]').forEach(b => b.onclick = () => verifyPhotoPayment(Number(b.dataset.verify), b));
}

// ---- "Verificar pago" ----
// El frente solo pregunta solo 2 min tras el regreso de Clip
// (pollPayment/pollCartPayment: cada 5 s x24). Con efectivo en OXXO
// Clip tarda más en confirmar, y después de esos 2 min no había forma
// de volver a preguntar: este botón lo hace a mano, cuando el usuario
// quiera. Reutiliza /api/checkout-status, que consulta el estado real
// en Clip; no hay endpoint nuevo ni se pregunta en bucle.
// Marca las fotos con un pago pendiente del usuario (una sola llamada
// con todos los ids): la rama {photoIds} de checkout-status lee las
// filas de pago locales, así que es barata y no toca a Clip. Solo el
// comprador tiene filas pendientes; el dueño de la foto no ve el botón
// en la cuadrícula (el servidor sí le permitiría verificar con
// {photoId}, pero no hay forma de listar sus pendientes sin un
// endpoint nuevo). Sin sesión o sin fotos de pago, no se llama.
async function markPendingPhotos(photos) {
  if (!token || !photos || !photos.length) return;
  const ids = photos.filter(p => p.freeMode === false && !p.owned).map(p => Number(p.id)).filter(Boolean);
  if (!ids.length) return;
  try {
    const s = await api('/api/checkout-status', { method: 'POST', body: JSON.stringify({ photoIds: ids }) });
    const pending = new Set((s.photos || []).filter(x => x.status === 'pending').map(x => Number(x.photoId)));
    photos.forEach(p => { if (pending.has(Number(p.id))) p._pending = true; });
  } catch (_) { /* sin estado de pagos, las tarjetas quedan como antes */ }
}

// Vuelve a preguntar a Clip si un pago pendiente de UNA foto ya se
// confirmó. Pagado: avisa y descarga con el flujo que ya existe.
// Todavía pendiente: no es un fallo, solo hay que esperar. Cancelado o
// vencido: el mensaje que ya existe. Si no se puede preguntar: que lo
// intente de nuevo.
async function verifyPhotoPayment(photoId, btn) {
  if (!photoId) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }
  try {
    const s = await api('/api/checkout-status', { method: 'POST', body: JSON.stringify({ photoId }) });
    if (s.paid) {
      alert('¡Pago confirmado! Descargando tu foto…');
      try { await downloadPhotoBlob(photoId); } catch (_) { alert('El pago quedó registrado, pero la descarga falló. Abre la foto en el evento y dale "Guardar".'); }
      if (lightboxPhoto && lightboxPhoto.id === photoId) hideLightbox();
      if (currentView === 'myphotos') loadMyPhotos();
      else if (currentEvent) loadEventDetail(currentEvent);
      return;
    }
    if (s.status === 'cancelled' || s.status === 'expired') {
      alert('El pago no se completó (cancelado o vencido). Puedes intentarlo de nuevo con "Pagar y descargar".');
      if (lightboxPhoto && lightboxPhoto.id === photoId) hideLightbox();
      if (currentEvent) loadEventDetail(currentEvent);
      return;
    }
    alert('Clip todavía no confirma tu pago, inténtalo en unos minutos.');
  } catch (_) {
    alert('No se pudo verificar el pago, inténtalo de nuevo.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Verificar pago'; }
  }
}

// "Verificar pago" del carrito: vuelve a preguntar a Clip por TODO el
// checkout (paymentRequestId) cuando el efectivo de OXXO tarda.
// Pagado: la caja de "¡Pago confirmado!" que ya existe. Cancelado o
// vencido: el mensaje que ya existe y el carrito sigue intacto.
async function verifyCartPayment(pid, btn) {
  if (!pid) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }
  try {
    const s = await api('/api/checkout-status', { method: 'POST', body: JSON.stringify({ paymentRequestId: pid }) });
    if (s.paid) { clearCart(); cartPaidBox(s.photoIds || []); return; }
    if (s.status === 'cancelled' || s.status === 'expired') { alert('El pago no se completó (cancelado o vencido). Tu carrito sigue intacto, puedes intentarlo de nuevo.'); renderCartView(); return; }
    alert('Clip todavía no confirma tu pago, inténtalo en unos minutos.');
  } catch (_) {
    alert('No se pudo verificar el pago, inténtalo de nuevo.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Verificar pago'; }
  }
}

// ---- Búsqueda: un solo botón, 3 métodos (idea de ZebraSnap) ----
// Un botón dorado ("Buscar por selfie o dorsal") en el inicio,
// en el detalle del evento y al final de la página abre este modal con
// 3 tarjetas grandes. Cada tarjeta entra al flujo que YA existe (no se
// reconstruye la búsqueda): selfie -> el buscador por selfie, dorsal ->
// un formulario dentro del mismo modal (Orlan 2026-11-17: que NO queden
// los botones viejos de dorsal/selfie por separado, solo el botón
// grande), ver todas -> el álbum del evento. Si ya estás en
// un evento, ese evento viene preseleccionado; si no, el más reciente.
// (La tercera tarjeta es "Ver todas las fotos": Orlan NO quiso buscar
// por color de ropa, así que el tercer método es recorrer el álbum.)
function onEventDetail() { return currentView === 'events' && !!currentEvent && !!((document.getElementById('eventDetail').innerHTML || '').trim()); }
// Botones de carrera del modal de búsqueda (Orlan 2026-11-18, opción 3):
// en el inicio la persona pica en QUÉ carrera buscar (por defecto la más
// reciente con fotos); dentro de un evento, el evento es fijo y los
// botones se esconden. Sin esto, un dorsal que existe en dos carreras
// distintas era ambiguo: la búsqueda solo miraba la más reciente.
let pickedEventId = null; // carrera elegida con los botones (null = la más reciente con fotos)
function pickedSearchEvent() {
  const id = pickedEventId || latestEventId;
  const ev = (homeEvents || []).find(e => String(e.id) === String(id));
  if (ev) return { id: ev.id, name: ev.name || '' };
  return { id: latestEventId, name: latestEventName || '' };
}
function searchModalEvent() {
  if (onEventDetail()) return { id: currentEvent, name: currentEventName || '' };
  return pickedSearchEvent();
}
function populateSearchEventButtons() {
  const wrap = document.getElementById('searchModalEventWrap');
  const box = document.getElementById('searchModalEventButtons');
  if (!wrap || !box) return;
  // Dentro de un evento no se elige: el evento ya está fijo.
  if (onEventDetail()) { wrap.style.display = 'none'; return; }
  const evs = homeEvents || [];
  if (!evs.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  if (!pickedEventId || !evs.some(e => String(e.id) === String(pickedEventId))) pickedEventId = latestEventId || evs[0].id;
  box.innerHTML = evs.map(e => `<button type="button" class="ev-pick-btn${String(e.id) === String(pickedEventId) ? ' sel' : ''}" data-ev="${e.id}">${esc(e.name || ('Evento ' + e.id))}${String(e.id) === String(pickedEventId) ? ' ✓' : ''}</button>`).join('');
  box.querySelectorAll('.ev-pick-btn').forEach(b => b.onclick = () => {
    pickedEventId = Number(b.dataset.ev);
    populateSearchEventButtons();
    const p = pickedSearchEvent();
    document.getElementById('searchModalEvent').textContent = p.id ? 'Evento: ' + (p.name || '') : 'Aún no hay eventos publicados.';
  });
}
function searchTargets() {
  // Dónde mostrar el avance y los resultados de la búsqueda por selfie:
  // en el evento si estás ahí, si no en el inicio.
  if (onEventDetail()) return { statusEl: $('#evFaceStatus'), resultsEl: $('#evGrid'), scope: 'event' };
  return { statusEl: $('#searchResults'), resultsEl: $('#searchResults'), scope: 'home' };
}
function showModalCards() {
  const cards = $('#searchModalCards'), bib = $('#searchModalBib');
  if (cards) cards.style.display = '';
  if (bib) bib.style.display = 'none';
}
function showModalBib() {
  const cards = $('#searchModalCards'), bib = $('#searchModalBib');
  if (cards) cards.style.display = 'none';
  if (bib) bib.style.display = '';
  const input = $('#modalBibInput');
  if (input) input.focus();
}
function openSearchModal(pref) {
  const modal = $('#searchModal');
  if (!modal) return;
  populateSearchEventButtons();
  const ev = searchModalEvent();
  const cards = $('#searchModalCards');
  $('#searchModalEvent').textContent = ev.id ? 'Evento: ' + (ev.name || '') : 'Aún no hay eventos publicados.';
  showModalCards();
  cards.innerHTML = `
    <button class="method-card" data-method="selfie"><strong>Por selfie</strong><p>Sube una foto de tu cara y te encontramos en todas las fotos.</p><p class="muted" style="margin-top:4px">Tu selfie nunca se guarda, solo se usa para buscar tus fotos.</p></button>
    <button class="method-card rec" data-method="bib"><strong>Por dorsal<span class="rec-tag">RECOMENDADO</span></strong><p>Escribe tu número de dorsal: es lo más rápido.</p></button>
    <button class="method-card" data-method="all"><strong>Ver todas las fotos</strong><p>Recorre el álbum completo del evento.</p></button>`;
  cards.querySelectorAll('[data-method]').forEach(b => b.onclick = () => {
    const m = b.dataset.method;
    if (m === 'selfie') {
      closeSearchModal();
      const p = searchModalEvent();
      if (!p.id) { alert('Aún no hay eventos para buscar.'); return; }
      const t = searchTargets();
      pickSelfieAndSearch(p.id, p.name, t.statusEl, t.resultsEl);
    } else if (m === 'bib') {
      showModalBib();
    } else if (m === 'all') {
      closeSearchModal();
      const p = searchModalEvent();
      if (!p.id) { showView('events'); return; }
      loadEventDetail(p.id, true);
    }
  });
  const bibBtn = $('#modalBibBtn');
  if (bibBtn) bibBtn.onclick = () => { const v = $('#modalBibInput') ? $('#modalBibInput').value : ''; runBibSearch(v); };
  const bibInput = $('#modalBibInput');
  if (bibInput) bibInput.onkeydown = (e) => { if (e.key === 'Enter') runBibSearch(bibInput.value); };
  const bibBack = $('#modalBibBack');
  if (bibBack) bibBack.onclick = showModalCards;
  if (pref === 'bib') showModalBib();
  modal.style.display = 'flex';
}
function closeSearchModal() { const m = $('#searchModal'); if (m) m.style.display = 'none'; }

// ---------- Documentos legales (Términos y Aviso de privacidad) ----------
// Textos completos aprobados por Orlan el 2026-11-18. Se muestran en un
// modal desde la sección "Legal" de la pestaña Cuenta. No se recorta nada.
const LEGAL_DOCS = {
  terms: { title: "Términos y Condiciones — OnlyClick", html: `<h2>Términos y Condiciones — OnlyClick</h2>
<p>Última actualización: 18 de noviembre de 2026.</p>
<h3>1. Aceptación de los términos</h3>
<p>Al usar OnlyClick aceptas estos términos. Si no estás de acuerdo, no uses la plataforma. Para crear una cuenta debes tener al menos 18 años y capacidad legal para contratar en México. Los menores de edad pueden aparecer en las fotos como participantes de un evento, pero las compras las hace un adulto o su tutor.</p>
<h3>2. Sobre el servicio</h3>
<p>OnlyClick es un marketplace de fotografía deportiva que conecta a fotógrafos con corredores y aficionados. Los fotógrafos publican y venden sus fotos de eventos deportivos; los compradores las encuentran con su número de dorsal o con una selfie, usando herramientas de búsqueda con inteligencia artificial, y las adquieren para uso personal. OnlyClick es operado en Ensenada, Baja California, México. Contacto: WhatsApp 644 453 1015 y onlyclick.com.mx.</p>
<h3>3. Tu cuenta</h3>
<p>Eres responsable de la información que registras y de toda la actividad que ocurra desde tu cuenta. Mantén tu contraseña en privado y avísanos de inmediato si detectas un acceso no autorizado. Una persona no puede operar varias cuentas para evadir límites o sanciones. OnlyClick aprueba a los fotógrafos: para vender primero llenas la solicitud y OnlyClick revisa y aprueba tu cuenta.</p>
<h3>4. Fotos: propiedad y licencia</h3>
<p>Los fotógrafos conservan la propiedad y los derechos de autor de las fotos que suben. Al publicarlas otorgan a OnlyClick una licencia no exclusiva y revocable para alojarlas, mostrarlas, generar vistas previas con marca de agua, detectar dorsales y rostros con IA, y venderlas dentro de la plataforma. Esta licencia se mantiene mientras las fotos estén publicadas y por el tiempo razonable necesario para completar las compras y obligaciones asociadas. Solo puedes subir fotos de las que tengas derechos: material propio o con autorización de quien las tomó.</p>
<h3>5. Eventos y álbumes</h3>
<p>Cada evento tiene un álbum con sus fotos. Los álbumes <strong>caducan 60 días después de la fecha del evento</strong> y se borran solos con todo su contenido (fotos y portada), incluidas las fotos ya compradas. Por eso debes descargar tus fotos antes de que se acabe ese plazo: cuando falten 15 días o menos verás el aviso "Se borra en N días" en Mis fotos y recibirás una notificación.</p>
<p>En los <strong>eventos compartidos</strong>, cualquier fotógrafo aprobado puede unirse con su propio precio por foto; el corredor busca su dorsal una vez y ve juntas las fotos de todos. En los <strong>álbumes exclusivos OnlyClick</strong>, contratados por un organizador, las fotos se descargan gratis para los participantes, el organizador le paga directo a OnlyClick y ningún otro fotógrafo puede subir fotos a la venta en ese álbum.</p>
<h3>6. Precios y descuentos</h3>
<p>El precio por foto lo fija cada fotógrafo para su evento. Aplican descuentos por volumen: la 4ª y 5ª foto tienen 20% de descuento, y el paquete de 10 fotos tiene 25% de descuento sobre el total. Los precios se muestran en pesos mexicanos (MXN) y pueden cambiar para eventos nuevos sin afectar compras ya hechas.</p>
<h3>7. Comisiones y pagos a fotógrafos</h3>
<p>Por cada venta se descuenta en total el <strong>13.8%</strong>: la comisión del procesador de pagos (Clip, 4.18% con IVA incluido) y la comisión de OnlyClick (10% después de Clip). El fotógrafo se queda con el <strong>86.2%</strong> restante. Ejemplo: en una foto de $20 MXN, Clip se queda $0.84, OnlyClick $1.92 y el fotógrafo $17.24.</p>
<p>Todo el dinero de las ventas cae en la cuenta de OnlyClick y OnlyClick le transfiere su parte a cada fotógrafo a su CLABE en un <strong>máximo de 72 horas</strong> después de la venta, y marca el pago como pagado en la plataforma. El fotógrafo puede ver su desglose (ventas, comisiones y pendiente por pagar) en su panel.</p>
<h3>8. Compras y uso permitido</h3>
<p>Cuando compras una foto recibes una licencia personal y no exclusiva para uso privado: imprimirla, guardarla y compartirla en tus redes sociales. No se permite el uso comercial, la reventa, cederla a medios ni usarla en publicidad sin autorización expresa por escrito del fotógrafo. Las vistas previas sin pagar llevan marca de agua ("ONLYCLICK • VISTA PREVIA"); quitar la marca de agua o redistribuir fotos descargadas está prohibido.</p>
<h3>9. Pagos y reembolsos</h3>
<p>Los pagos se procesan con <strong>Clip</strong>: tarjeta de crédito o débito y efectivo en OXXO. El límite por transacción es de $5,000 MXN. Las fotos son un producto digital: <strong>no hay reembolsos una vez descargada la foto</strong>, salvo que la foto esté defectuosa o no corresponda a lo que compraste (por ejemplo, no eres tú o no es tu dorsal). En ese caso repórtalo <strong>dentro de los 7 días</strong> siguientes a la compra desde la página de la orden o por WhatsApp; OnlyClick revisa el caso y puede reembolsar la orden o una parte. Si pagaste en efectivo en OXXO, la confirmación del pago puede tardar hasta 2 días hábiles.</p>
<h3>10. Impuestos</h3>
<p>Los fotógrafos venden por cuenta propia, no como empleados ni agentes de OnlyClick, y son los únicos responsables de declarar esos ingresos y de los impuestos que les correspondan en México (ISR, IVA). OnlyClick no retiene ni paga impuestos por cuenta de los fotógrafos, salvo que la ley lo exija.</p>
<h3>11. Funciones de inteligencia artificial</h3>
<p>OnlyClick usa IA para detectar dorsales en las fotos y para buscar tus fotos con una selfie. Estas funciones se ofrecen tal cual: mejoran con el uso, pero no garantizan resultados perfectos (una foto puede no aparecer aunque salgas en ella, o puede aparecer una que no es tuya; revísala antes de comprar). <strong>Tu selfie no se guarda</strong>: se usa solo para esa búsqueda y se descarta. No usamos las fotos de los fotógrafos para entrenar modelos de terceros.</p>
<h3>12. Conducta aceptable</h3>
<ul>
<li>No puedes usar OnlyClick para subir o compartir contenido ilegal, difamatorio, violento, sexualmente explícito, discriminatorio o que infrinja derechos de terceros.</li>
<li>No puedes interferir con la plataforma, intentar acceder a áreas restringidas, evadir límites de uso, descargar fotos de forma masiva ni usar bots no autorizados para extraer fotos o datos.</li>
<li>No puedes suplantar a otra persona, registrar información falsa ni revender el acceso a tu cuenta.</li>
</ul>
<h3>13. Reportes y contenido ofensivo</h3>
<p>OnlyClick tiene tolerancia cero con el contenido ofensivo y los usuarios abusivos. Cualquier persona puede reportar una foto, un álbum, un evento o un usuario por WhatsApp o desde la plataforma. Revisamos cada reporte y el contenido que incumple estos términos se elimina; la cuenta que lo publicó se suspende o se cierra.</p>
<h3>14. Propiedad intelectual de OnlyClick</h3>
<p>La marca, el logo, el sitio, el código y los materiales de OnlyClick son propiedad de OnlyClick. No puedes copiarlos, modificarlos ni usarlos comercialmente sin autorización por escrito. Las fotos publicadas en la plataforma siguen siendo de sus respectivos fotógrafos.</p>
<h3>15. Reclamaciones por infracción de derechos</h3>
<p>Si crees que una foto u otro contenido publicado en OnlyClick infringe tus derechos, escríbenos por WhatsApp con la información necesaria para evaluar el reclamo (identificación de la obra, prueba de titularidad, enlace del contenido y tus datos de contacto). Retiramos rápido el contenido que claramente infrinja derechos y suspendemos cuentas con infracciones reincidentes.</p>
<h3>16. Enlaces y servicios de terceros</h3>
<p>OnlyClick puede enlazar a sitios o integrarse con servicios de terceros (Clip para pagos, WhatsApp, redes sociales, servicios de alojamiento e IA). No controlamos esos servicios y no respondemos por su contenido, disponibilidad o políticas. Tu uso de servicios externos se rige por sus propios términos.</p>
<h3>17. Comunicaciones</h3>
<p>Aceptas recibir comunicaciones electrónicas relacionadas con tu cuenta, ventas, compras, soporte y novedades del producto. Puedes desactivar las comunicaciones de marketing desde la configuración de tu cuenta. Las comunicaciones operacionales (pagos, avisos de caducidad de álbumes, alertas legales) no se pueden desactivar mientras tengas una cuenta activa.</p>
<h3>18. Sin garantías</h3>
<p>OnlyClick se ofrece tal cual y según disponibilidad. No garantizamos disponibilidad ininterrumpida, precisión absoluta de la IA, conservación indefinida de los archivos ni resultados específicos de venta. Trabajamos para mantener un servicio estable, pero el uso es bajo tu propio riesgo.</p>
<h3>19. Limitación de responsabilidad</h3>
<p>En la máxima medida permitida por la ley, OnlyClick no responde por daños indirectos, incidentales, especiales, punitivos o consecuentes, ni por pérdida de ganancias, datos o reputación derivados del uso de la plataforma. Nuestra responsabilidad total agregada en cualquier caso queda limitada a los montos que nos hayas pagado en los doce meses previos al hecho que motivó el reclamo.</p>
<h3>20. Indemnización</h3>
<p>Te comprometes a mantener indemne a OnlyClick, sus directivos y colaboradores frente a reclamos de terceros derivados del contenido que publiques, del uso indebido de la plataforma o del incumplimiento de estos términos.</p>
<h3>21. Cambios en los términos</h3>
<p>Podemos actualizar estos términos cuando lancemos nuevas funciones, cambien las regulaciones aplicables o necesitemos aclarar reglas. Avisaremos los cambios materiales por correo o dentro de la plataforma antes de que entren en vigor. Si sigues usando la plataforma después de la fecha indicada, aceptas la nueva versión.</p>
<h3>22. Suspensión y terminación</h3>
<p>Puedes cerrar tu cuenta cuando quieras desde tu configuración. Podemos suspender o terminar cuentas que incumplan estos términos, presenten riesgo legal o de seguridad, o realicen fraude. Antes de una terminación definitiva intentamos contactarte y darte oportunidad de apelar, salvo que un cierre inmediato sea necesario por motivos legales.</p>
<h3>23. Ley aplicable</h3>
<p>Estos términos se rigen por las leyes de México. Cualquier controversia se someterá a los tribunales competentes de Ensenada, Baja California, salvo que la ley de protección al consumidor disponga otra cosa de forma obligatoria.</p>
<h3>24. Disposiciones generales</h3>
<p>Si alguna cláusula resulta inválida, las demás siguen vigentes. La falta de ejercicio de un derecho no implica renuncia. No puedes ceder estos términos sin nuestro consentimiento; nosotros sí podemos cederlos a una entidad sucesora. Los reclamos deben presentarse en el plazo máximo de un año desde el hecho que les dio origen, salvo que la ley aplicable establezca lo contrario.</p>` },
  privacy: { title: "Aviso de Privacidad — OnlyClick", html: `<h2>Aviso de Privacidad — OnlyClick</h2>
<p>Última actualización: 18 de noviembre de 2026.</p>
<p>OnlyClick, con domicilio en Ensenada, Baja California, México, es responsable del tratamiento de tus datos personales. Contacto: WhatsApp 644 453 1015 y onlyclick.com.mx.</p>
<h3>1. Información que recopilamos</h3>
<ul>
<li><strong>Datos de cuenta:</strong> correo electrónico, nombre, contraseña (guardada con hash, nunca la vemos en texto plano), tipo de cuenta (atleta o fotógrafo) y el nombre con el que firmas tus fotos.</li>
<li><strong>Datos de fotógrafos:</strong> CLABE para pagarte tus ventas, historial de ventas y ganancias.</li>
<li><strong>Fotos y metadatos:</strong> las imágenes que subes como fotógrafo, los dorsales que detecta la IA, las portadas de los eventos y los datos del álbum.</li>
<li><strong>Selfies para búsqueda:</strong> cuando buscas tus fotos con una selfie, la foto se usa solo para esa búsqueda y <strong>no se guarda</strong>. Se descarta al terminar.</li>
<li><strong>Compras y pagos:</strong> órdenes, fotos compradas, totales y metadatos de pago. Los números de tarjeta los procesa Clip directamente, nunca los guardamos nosotros.</li>
<li><strong>Datos de uso y dispositivo:</strong> páginas que visitas, búsquedas que haces, dirección IP, navegador e idioma, para que la plataforma funcione y para seguridad.</li>
<li><strong>Cookies y tecnologías similares:</strong> solo las estrictamente necesarias para mantener tu sesión activa, recordar tu carrito y tus preferencias. No usamos cookies de publicidad ni de analítica de terceros.</li>
</ul>
<h3>2. Cómo usamos tus datos</h3>
<ul>
<li>Operar la plataforma: mostrar fotos, procesar compras, pagarle a los fotógrafos y darte soporte.</li>
<li>Funciones de IA: detección de dorsales y búsqueda por selfie para que encuentres tus fotos.</li>
<li>Mejorar el servicio: analizar el uso de forma general para detectar errores y priorizar funciones.</li>
<li>Seguridad y prevención de fraude: detectar abuso, proteger cuentas y cumplir obligaciones legales. Los registros de compra se usan para prevenir fraudes y para responder disputas de pago.</li>
<li>Comunicación: enviarte avisos de tu cuenta, de tus ventas o compras, de la caducidad de álbumes y novedades del producto. Puedes salirte del marketing cuando quieras.</li>
</ul>
<p><strong>No vendemos tus datos y no los compartimos con anunciantes.</strong></p>
<h3>3. Reconocimiento facial y datos biométricos</h3>
<ul>
<li>Las fotos de los fotógrafos se procesan con inteligencia artificial (Google Gemini) para detectar dorsales y rostros y ayudarte a encontrar tus fotos.</li>
<li>Cuando buscas por selfie, tu foto se compara con las fotos del evento solo durante esa búsqueda y <strong>se elimina al terminar. No la guardamos, no la vendemos y no la usamos para entrenar modelos de terceros.</strong></li>
<li>La búsqueda por selfie es opcional. Puedes buscar por evento, fecha o dorsal sin necesidad de usarla.</li>
</ul>
<h3>4. Con quién compartimos información</h3>
<ul>
<li><strong>Proveedores de servicio que necesitamos:</strong> Clip (pagos), Supabase (alojamiento, base de datos y almacenamiento de fotos), Vercel (alojamiento del sitio), Google Gemini (inteligencia artificial) y Gmail (correos de avisos y ventas).</li>
<li><strong>Fotógrafos y compradores:</strong> cuando compras, el fotógrafo ve qué se vendió y los datos de la orden que necesita para completarla; nunca recibe tus datos de tarjeta.</li>
<li><strong>Cumplimiento legal y seguridad:</strong> cuando lo requiera la ley, una orden judicial, o para proteger a los usuarios de fraude, abuso o daño inminente.</li>
<li><strong>Transferencias de negocio:</strong> si OnlyClick participa en una fusión, venta o reestructura, tus datos pueden transferirse a la nueva entidad bajo los mismos términos.</li>
</ul>
<h3>5. Cookies</h3>
<p>Usamos solo cookies y almacenamiento local estrictamente necesarios para que la plataforma funcione: mantener tu sesión activa, guardar tu carrito (separado por cuenta) y recordar tus preferencias. No usamos cookies de publicidad ni de medición de terceros. Si desactivas las necesarias, partes de la plataforma pueden dejar de funcionar.</p>
<h3>6. Seguridad</h3>
<ul>
<li>Los datos viajan cifrados (TLS) entre tu teléfono y nuestros servidores.</li>
<li>Las contraseñas se guardan con hash moderno; nunca las vemos en texto plano.</li>
<li>El acceso a los datos se limita al personal autorizado de OnlyClick.</li>
</ul>
<p>Ningún sistema es perfecto. Si encuentras una vulnerabilidad, escríbenos por WhatsApp para arreglarla rápido.</p>
<h3>7. Tus derechos (ARCO)</h3>
<p>Conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP), tienes derecho a:</p>
<ul>
<li><strong>Acceso:</strong> saber qué información tenemos sobre ti.</li>
<li><strong>Rectificación:</strong> corregir tu perfil y tus datos.</li>
<li><strong>Cancelación:</strong> pedir que borremos tus datos personales que no debamos conservar por motivos legales.</li>
<li><strong>Oposición:</strong> oponerte a usos específicos (como marketing) o limitar ciertos tratamientos.</li>
<li><strong>Revocación del consentimiento:</strong> salirte de funciones como la búsqueda por selfie y el marketing cuando quieras.</li>
</ul>
<p>Para ejercer estos derechos escríbenos por WhatsApp al 644 453 1015 o desde tu cuenta. Te responderemos en los plazos que marca la ley.</p>
<h3>8. Retención de datos</h3>
<ul>
<li><strong>Datos de cuenta:</strong> se mantienen mientras tu cuenta está activa. Tras eliminarla se borran o anonimizan en un plazo razonable, salvo lo que debamos conservar por obligación legal, contable o anti-fraude.</li>
<li><strong>Fotos:</strong> se mantienen mientras el álbum está publicado. Los álbumes caducan 60 días después de la fecha del evento y se borran con todo su contenido.</li>
<li><strong>Selfies:</strong> nunca se guardan; se descartan al terminar cada búsqueda.</li>
<li><strong>Registros de compras y fiscales:</strong> se conservan el tiempo requerido por la legislación fiscal y contable.</li>
</ul>
<h3>9. Menores de edad</h3>
<p>OnlyClick no se dirige a menores de 18 años para crear cuentas. Sin embargo, los menores pueden aparecer en las fotos como participantes de un evento deportivo, y las compras las hace un adulto o su tutor. Si crees que un menor creó una cuenta o que tenemos información de un menor, escríbenos y la borraremos.</p>
<h3>10. Transferencias internacionales</h3>
<p>OnlyClick opera desde México y usa proveedores ubicados en Estados Unidos (Supabase, Vercel, Google y Clip). Cuando tus datos se procesan en esos servicios, se transfieren conforme a los mecanismos reconocidos por las leyes de privacidad aplicables.</p>
<h3>11. Cambios a este aviso</h3>
<p>Podemos actualizar este aviso cuando lancemos funciones, cambien las regulaciones o cambien proveedores. Avisaremos los cambios materiales por correo o dentro de la plataforma antes de que entren en vigor. La fecha al inicio refleja la versión más reciente.</p>` },
};
function openLegalDoc(key) {
  const doc = LEGAL_DOCS[key]; if (!doc) return;
  const titleEl = $('#legalModalTitle'); if (titleEl) titleEl.textContent = doc.title;
  const body = $('#legalModalBody');
  if (body) { body.innerHTML = doc.html; body.scrollTop = 0; }
  const m = $('#legalModal'); if (m) m.style.display = 'flex';
}
function closeLegalDoc() { const m = $('#legalModal'); if (m) m.style.display = 'none'; }

// ---- Sin resultados: 3 salidas en vez de un "no hay fotos" ----
// Cuando una búsqueda por dorsal o selfie no encuentra nada, se muestra
// "Todavía no te encontramos" con tres caminos: probar con el dorsal,
// probar con la selfie, o ver todo (el álbum en el evento, los eventos
// en el inicio). OnlyClick no tiene panel de filtros: "ajustar filtros"
// es ver todas las fotos del evento (o todos los eventos).
function emptySearchHtml(opts) {
  const what = opts.bib ? 'el dorsal ' + opts.bib : 'tu cara';
  return `<div class="card"><h3>Todavía no te encontramos</h3>
  <p class="muted">No hay fotos con ${esc(what)}${opts.eventName ? ' en ' + esc(opts.eventName) : ' en ningún evento'}.</p>
  <div class="row">
    <button class="primary" data-empty="bib">Prueba con tu dorsal</button>
    <button class="primary" data-empty="selfie">Prueba con una selfie</button>
    <button class="secondary" data-empty="browse">${opts.scope === 'event' ? 'Ver todas las fotos' : 'Ver eventos'}</button>
  </div></div>`;
}
function bindEmptySearch(box, ctx) {
  box.querySelectorAll('[data-empty]').forEach(b => b.onclick = () => {
    const kind = b.dataset.empty;
    if (kind === 'bib') {
      // Abrir el modal ya en el formulario de dorsal (ya no hay campo
      // de dorsal fuera del modal).
      openSearchModal('bib');
    } else if (kind === 'selfie') {
      if (ctx.eventId) pickSelfieAndSearch(ctx.eventId, ctx.eventName, ctx.statusEl, ctx.resultsEl);
      else alert('Aún no hay eventos para buscar.');
    } else if (kind === 'browse') {
      if (ctx.scope === 'event' && ctx.eventId) loadEventDetail(ctx.eventId);
      else showView('events');
    }
  });
}
function emptySearchCtx(eventId, eventName, statusEl, resultsEl) {
  const scope = (onEventDetail() && currentEvent === eventId) ? 'event' : 'home';
  return { eventId, eventName, statusEl, resultsEl, scope };
}

// Buscar por dorsal desde el formulario del modal. En el inicio busca
// en la carrera elegida con los botones del modal (por defecto la más
// reciente con fotos); dentro de un evento, solo en ese evento. Los
// resultados se muestran donde corresponde (inicio o detalle) y el modal
// se cierra al buscar.
async function runBibSearch(bib) {
  bib = String(bib || '').trim();
  if (!bib) return;
  closeSearchModal();
  const ev = searchModalEvent();
  const t = searchTargets();
  const box = t.resultsEl;
  if (!box) return;
  if (bib.includes('@')) { box.innerHTML = '<p>Escribe solo tu número de dorsal, sin correo.</p>'; return; }
  box.innerHTML = '<p>Buscando…</p>';
  try {
    const r = await api('/api/search?bib=' + encodeURIComponent(bib) + (ev.id ? '&eventId=' + ev.id : ''));
    currentPhotos = r.photos;
    if (r.photos.length) {
      // #evGrid YA es una cuadrícula: no anidar otra dentro (el título
      // ocupaba la primera celda y TODAS las fotos caían en la segunda
      // columna, apiladas a la derecha). En el inicio (#searchResults,
      // un div normal) sí hace falta el grid interno.
      const cards = r.photos.map(p => photoCard(p)).join('');
      box.innerHTML = t.scope === 'event'
        ? `<p style="grid-column: 1 / -1">${r.photos.length} foto(s) con el dorsal ${esc(bib)}:</p>${cards}`
        : `<p>${r.photos.length} foto(s) con el dorsal ${esc(bib)}:</p><div class="grid">${cards}</div>`;
    } else {
      const ctx = emptySearchCtx(ev.id || latestEventId, ev.name || latestEventName, t.statusEl, box);
      box.innerHTML = emptySearchHtml({ bib, eventName: ev.name || latestEventName, scope: ctx.scope });
      bindEmptySearch(box, ctx);
    }
    bindPhotos(r.photos);
    trackView('search', null, ev.id || null, bib);
  } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

// ---- Búsqueda por selfie, Fase 1 (reconocimiento facial con Gemini) ----
// La selfie se compara contra las fotos del evento en lotes de 8, con 4
// llamadas en paralelo a /api/face-search. Cada lote es una llamada
// corta (el servidor solo lee 8 miniaturas y hace una llamada a Gemini),
// así ninguna pasa de ~10 s y la búsqueda completa de un evento grande
// tarda ~1-3 min. El avance y el tiempo estimado se muestran mientras
// tanto. La selfie NO se sube para guardarse: solo viaja en el cuerpo de
// cada llamada y el servidor la usa y la olvida. No hay cobro en Fase 1.
const FACE_BATCH = 8;
const FACE_WORKERS = 4;

// Resolución de una imagen ya cargada (para guardar los metadatos de la
// foto al subirla: la vista ampliada los muestra sin volver a leerla).
function imageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Achica una imagen en el teléfono (el downscale del panel vive dentro
// de loadPhotographer y aquí no se ve): la selfie se manda en 800px.
function downscaleImage(dataUrl, maxW, quality) {
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

function faceTimeLeft(startedAt, checked, total) {
  if (!checked || !total || checked >= total) return '';
  const el = (Date.now() - startedAt) / 1000;
  const left = Math.max(0, Math.round((el / checked) * (total - checked)));
  if (left < 60) return ' · quedan ~' + left + ' s';
  return ' · quedan ~' + Math.ceil(left / 60) + ' min';
}

async function runFaceSearch(eventId, eventName, selfieDataUrl, statusEl, resultsEl) {
  const state = { cancelled: false, stopped: '', checked: 0, total: 0, errors: 0, matches: new Map(), startedAt: Date.now() };
  const selfieBase64 = selfieDataUrl.split(',')[1] || '';
  function renderStatus() {
    if (!statusEl) return;
    statusEl.innerHTML = `Buscando tu cara en ${esc(eventName)}… revisadas ${state.checked} de ${state.total} fotos${faceTimeLeft(state.startedAt, state.checked, state.total)} <button id="faceCancel" class="secondary">Cancelar</button>`;
    const c = statusEl.querySelector('#faceCancel');
    if (c) c.onclick = () => { state.cancelled = true; statusEl.textContent = 'Cancelando…'; };
  }
  function renderResults(note) {
    const list = [...state.matches.values()];
    currentPhotos = list;
    if (!resultsEl) return;
    if (list.length) {
      // #evGrid YA es una cuadrícula: no anidar otra dentro (mismo bug
      // que en la búsqueda por dorsal: el título ocupaba la primera
      // celda y todas las fotos caían en la segunda columna). En el
      // inicio (#searchResults, div normal) sí hace falta el interno.
      const cards = list.map(p => photoCard(p)).join('');
      const title = `${list.length} foto(s) donde sales tú en ${esc(eventName)}:${note ? ' ' + esc(note) : ''}`;
      resultsEl.innerHTML = resultsEl.classList.contains('grid')
        ? `<p style="grid-column: 1 / -1">${title}</p>${cards}`
        : `<p>${title}</p><div class="grid">${cards}</div>`;
    } else {
      const ctx = emptySearchCtx(eventId, eventName, statusEl, resultsEl);
      resultsEl.innerHTML = emptySearchHtml({ eventName, scope: ctx.scope }) + '<p class="muted">Tip: prueba con otra selfie de frente y con buena luz.</p>' + (note ? `<p class="muted">${esc(note)}</p>` : '');
      bindEmptySearch(resultsEl, ctx);
    }
    bindPhotos(list);
    if (statusEl && statusEl !== resultsEl) statusEl.textContent = '';
  }
  async function oneChunk(offset) {
    if (state.cancelled) return;
    try {
      const r = await api('/api/face-search', { method: 'POST', body: JSON.stringify({ eventId, selfieBase64, mimeType: 'image/jpeg', offset, limit: FACE_BATCH }) });
      if (!r.ok) {
        // Sin llave de IA o la IA no respondió: no vale la pena seguir.
        state.errors++;
        if (r.reason === 'no-key') { state.stopped = 'no-key'; state.cancelled = true; if (statusEl) statusEl.textContent = 'La búsqueda por selfie no está disponible ahorita, prueba con tu dorsal.'; return; }
        if (r.reason === 'ia-error') { state.stopped = 'ia-error'; state.cancelled = true; if (statusEl) statusEl.textContent = 'La IA no respondió, inténtalo de nuevo en un rato.'; return; }
        return;
      }
      if (state.total === 0) state.total = Number(r.total) || 0;
      state.checked += Number(r.checked) || 0;
      for (const p of (r.matches || [])) if (!state.matches.has(p.id)) state.matches.set(p.id, p);
      renderStatus();
    } catch (_) { state.errors++; state.checked += FACE_BATCH; renderStatus(); }
  }
  if (statusEl) statusEl.textContent = 'Buscando tu cara…';
  // Primer lote: dice cuántas fotos tiene el evento y calienta la
  // conexión. Los demás lotes van después, 4 en paralelo.
  await oneChunk(0);
  if (!state.cancelled && state.total > FACE_BATCH) {
    const offsets = [];
    for (let o = FACE_BATCH; o < state.total; o += FACE_BATCH) offsets.push(o);
    await runPool(offsets, FACE_WORKERS, oneChunk);
  }
  if (state.cancelled) {
    // Si la IA se detuvo y ya había fotos encontradas, se muestran con
    // el aviso; si no había ninguna, queda el mensaje de error en statusEl.
    if (state.stopped && state.matches.size) { renderResults('La IA dejó de responder, se muestran las fotos revisadas hasta ahora.'); return; }
    if (state.stopped) return;
    // Si se canceló a la mitad, se muestra lo que sí se alcanzó a revisar.
    renderResults('Búsqueda cancelada, se muestran las fotos revisadas hasta ahora.');
    return;
  }
  renderResults(state.errors ? 'Algunas fotos no se pudieron revisar, si no aparece tu foto inténtalo de nuevo.' : '');
}

// Abre el selector de foto del teléfono, achica la selfie y arranca la
// búsqueda en el evento dado. statusEl muestra el avance, resultsEl las
// fotos encontradas (pueden ser el mismo elemento, como en el inicio).
async function pickSelfieAndSearch(eventId, eventName, statusEl, resultsEl) {
  if (!eventId) { if (statusEl) statusEl.textContent = 'Aún no hay eventos para buscar.'; return; }
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { if (statusEl) statusEl.textContent = 'Ese archivo no es una foto.'; return; }
    if (statusEl) statusEl.textContent = 'Preparando tu selfie…';
    const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
    let small = await downscaleImage(dataUrl, 800, 0.85);
    if (small.length > 2.5 * 1024 * 1024) small = await downscaleImage(dataUrl, 500, 0.8);
    runFaceSearch(eventId, eventName, small, statusEl, resultsEl);
  };
  input.click();
}

// Tarjeta de evento: portada, nombre, fecha, fotos reales y precio real
// por foto ("Desde $X MXN/foto" o "Descarga gratis"). NUNCA se inventan
// eventos ni precios: solo se muestran los que devuelve /api/events.
// PAQUETE: mostrar cuando Orlan defina el precio — p. ej. una línea
// "Todas tus fotos $Y MXN" junto al precio por foto. No mostrar precio
// inventado.
function eventCard(e) {
  const price = Number(e.priceMxn || 20);
  // Álbum "Próximo evento": se ve la portada, el título y la fecha con la
  // etiqueta "Próximo evento", SIN precio y SIN abrirse (no hay fotos
  // todavía). La tarjeta lleva data-upcoming para que el clic no abra la
  // galería (bindEventCards), ni al dueño.
  if (e.isUpcoming) {
    return `<div class="event-card" data-ev="${e.id}" data-upcoming="1" role="button" tabindex="0">
    ${e.coverPath ? `<img class="event-cover" src="${coverImgUrl(e.id, !!e.isHidden)}" alt="" loading="lazy">` : '<div class="event-cover event-cover-empty"></div>'}
    <div class="event-body">
      <strong>${esc(e.name)}</strong> <span class="badge official">Próximo evento</span> ${e.isHidden ? '<span class="badge">Oculto</span>' : ''}
      ${e.photographerName ? `<span class="muted">Fotos de ${esc(e.photographerName)}</span>` : ''}
      <span class="muted">${esc(e.sport)} · ${esc(e.eventDate)} · ${esc(e.location)}</span>
      <span class="event-meta">Las fotos estarán disponibles después de la carrera</span>
      <span class="event-cta">Próximamente</span>
    </div></div>`;
  }
  const priceTxt = e.freeMode ? 'Descarga gratis' : 'Desde $' + price + ' MXN/foto';
  return `<div class="event-card" data-ev="${e.id}" role="button" tabindex="0">
    ${e.coverPath ? `<img class="event-cover" src="${coverImgUrl(e.id, !!e.isHidden)}" alt="" loading="lazy">` : '<div class="event-cover event-cover-empty"></div>'}
    <div class="event-body">
      <strong>${esc(e.name)}</strong> ${e.isExclusive ? '<span class="badge official">Exclusivo OnlyClick</span>' : (e.isOfficial ? '<span class="badge official">✓ Álbum oficial Only Click</span>' : '')} ${e.isHidden ? '<span class="badge">Oculto</span>' : ''}
      ${e.photographerName ? `<span class="muted">Fotos de ${esc(e.photographerName)}</span>` : ''}
      ${e.isShared ? `<span class="badge">Evento compartido · ${e.participantsCount || 2} fotógrafos</span>` : ''}
      <span class="muted">${esc(e.sport)} · ${esc(e.eventDate)} · ${esc(e.location)}</span>
      <span class="event-meta">${e.photoCount || 0} fotos · ${priceTxt}</span>
      <span class="event-cta">Ver fotos →</span>
    </div></div>`;
}

function bindEventCards() {
  document.querySelectorAll('[data-ev]').forEach(b => {
    b.onclick = () => {
      // Tarjeta "Próximo evento": no se abre el detalle para nadie (no hay
      // fotos todavía y el detalle repetía la misma tarjeta abajo). El dueño
      // lo gestiona en su panel (Gestión → Mis eventos).
      if (b.dataset.upcoming) { showToast(me && me.isOwner ? 'Es un Próximo evento: gestiónalo en tu panel (Gestión → Mis eventos).' : 'Las fotos estarán disponibles después de la carrera.'); return; }
      loadEventDetail(Number(b.dataset.ev), true);
    };
    b.onkeydown = (e) => { if (e.key === 'Enter') b.onclick(); };
  });
}

// Inicio (público, sin login): tarjetas de eventos recientes + cinta de
// fotos mezcladas de todos los álbumes visibles. El titular del hero es
// estático (HTML); el evento más reciente solo se usa como referencia.
async function loadHome() {
  try {
    const r = await api('/api/events');
    const evs = r.events || [];
    if (evs.length) {
      // La búsqueda del inicio apunta al evento más reciente CON fotos:
      // los "Próximo evento" (sin fotos todavía) y los ocultos no cuentan.
      // Si ninguno califica, queda en null y la búsqueda es global.
      const searchable = evs.filter(e => !e.isUpcoming && !e.isHidden && (e.photoCount || 0) > 0);
      // Lista para el selector de carrera del modal (más reciente primero).
      homeEvents = [...searchable].sort((a, b) => String(b.eventDate || '').localeCompare(String(a.eventDate || '')));
      const ev = homeEvents[0];
      latestEventId = ev ? ev.id : null; latestEventName = ev ? ev.name : '';
    } else {
      latestEventId = null; latestEventName = ''; homeEvents = [];
    }
    $('#homeEvents').innerHTML = evs.length ? evs.map(e => eventCard(e)).join('') : '<p class="muted">Aún no hay eventos publicados.</p>';
    bindEventCards();
    buildPhotoStrip(evs);
  } catch (e) {
    homeEvents = []; latestEventId = null; latestEventName = '';
    $('#homeEvents').innerHTML = '<p class="muted">No se pudieron cargar los eventos.</p>';
  }
}

// Cinta de fotos del inicio: mezcla fotos de TODOS los álbumes visibles
// (unas del Trijex, otras del último, por ejemplo), repartidas por todo
// cada álbum (principio, medio y final), las revuelve y las hace correr en
// bucle. Sin recorte: cada foto se muestra con su proporción natural para
// que no se corte la cabeza. Los álbumes ocultos NO entran en la cinta:
// un álbum oculto no debe asomarse en el inicio ni siquiera con sus
// fotos. Si no hay fotos, la cinta queda vacía.
async function buildPhotoStrip(evs) {
  const box = $('#photoStrip');
  if (!box) return;
  try {
    // Solo álbumes visibles con fotos, los 5 más nuevos (para no hacer
    // muchas peticiones). Los próximos eventos tampoco entran: aún no
    // tienen fotos que mostrar (y si el dueño ya subió alguna, no se
    // asoma hasta quitar lo de próximo).
    const withPhotos = (evs || []).filter(e => (e.photoCount || 0) > 0 && !e.isHidden && !e.isUpcoming);
    if (!withPhotos.length) return;
    const newest = [...withPhotos].sort((a, b) => String(b.eventDate || '').localeCompare(String(a.eventDate || ''))).slice(0, 5);
    const lists = (await Promise.all(newest.map(ev => api('/api/event-get?eventId=' + ev.id)))).map(r => (r.photos || []).slice()).filter(l => l.length);
    if (!lists.length) return;
    // Reparto: 10 fotos como máximo, una por álbum por ronda, para que el
    // mix se vea (si un álbum tiene pocas fotos, los demás completan).
    const takes = lists.map(() => 0);
    let left = 10;
    while (left > 0) {
      let added = false;
      for (let i = 0; i < lists.length && left > 0; i++) {
        if (takes[i] < lists[i].length) { takes[i]++; left--; added = true; }
      }
      if (!added) break;
    }
    // Spread-pick dentro de cada álbum + round-robin entre álbumes.
    const spread = lists.map((photos, i) => {
      const out = [];
      for (let k = 0; k < takes[i]; k++) out.push(photos[Math.floor(k * photos.length / takes[i])]);
      return out;
    });
    const picked = [];
    for (let r = 0; picked.length < 10; r++) {
      let added = false;
      for (let i = 0; i < spread.length && picked.length < 10; i++) {
        if (r < spread[i].length) { picked.push(spread[i][r]); added = true; }
      }
      if (!added) break;
    }
    if (!picked.length) return;
    for (let i = picked.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = picked[i]; picked[i] = picked[j]; picked[j] = t; }
    const imgs = picked.map(p => '<img src="' + photoImgUrl(p.id, true, false) + '" alt="Foto del evento" loading="lazy">').join('');
    box.innerHTML = '<div class="marquee"><div class="marquee-track">' + imgs + imgs + '</div></div>';
  } catch (e) { /* sin cinta si falla */ }
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
  currentEventName = r.event.name || '';
  currentEventHidden = !!r.event.isHidden; // para el token de la foto ampliada
  currentTipClabe = r.tipClabe || '';
  currentTipName = r.tipName || '';
  // El precio por foto ya viene del servidor (cada fotógrafo el suyo):
  // aquí solo se marca si el evento es gratis.
  r.photos.forEach(p => { p.freeMode = r.event.freeMode; });
  // Si el usuario tiene un pago pendiente en alguna foto, su tarjeta
  // lleva el botón "Verificar pago" (una sola llamada, antes de dibujar).
  await markPendingPhotos(r.photos);
  $('#eventDetail').innerHTML = `
    <h3>${esc(r.event.name)}</h3>
    ${r.event.isHidden ? '<p><span class="badge">Oculto — solo tú lo ves</span></p>' : ''}
    ${r.event.isUpcoming ? '<p><span class="badge official">Próximo evento</span></p><p class="muted">Este álbum se ve como próximo evento: sin precio y sin abrirse para los demás. Quítalo en Gestión cuando subas las fotos.</p>' : ''}
    ${r.event.isExclusive ? '<p><span class="badge official">Exclusivo OnlyClick</span></p>' : (r.isOfficial ? '<p><span class="badge official">✓ Álbum oficial Only Click</span></p>' : '')}
    ${r.photographerName ? `<p class="muted">Fotos de ${esc(r.photographerName)}</p>` : ''}
    ${r.participants && r.participants.length > 1 ? `<p><span class="badge">Evento compartido · ${r.participants.length} fotógrafos</span></p><p class="muted">Participan: ${r.participants.map(pt => esc(pt.displayName) + ' ($' + pt.priceMxn + '/foto)').join(' · ')}</p>` : ''}
    ${me && me.role === 'photographer' && me.approved !== false && r.event.photographerId !== me.id && !r.event.isExclusive ? (r.isParticipant
      ? `<p class="ok">Ya participas en este evento · Tu precio: $${r.myPrice || r.event.priceMxn} MXN por foto</p>`
      : `<div class="card"><p><strong>¿Vas a cubrir este evento?</strong> Únete y sube tus fotos aquí: cada quien vende las suyas a su precio.</p><div class="row"><input id="joinPrice" type="number" min="1" max="5000" value="20" style="max-width:130px"><button id="joinBtn" class="primary">Unirme a este evento</button></div><p id="joinStatus" class="muted"></p></div>`) : ''}
    ${r.event.coverPath ? `<img src="${coverImgUrl(eventId, !!r.event.isHidden)}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px">` : ''}
    <p class="muted">${esc(r.event.sport)} · ${esc(r.event.eventDate)} · ${esc(r.event.location)} · ${r.event.freeMode ? 'Descarga gratis' : 'De pago · $' + (r.event.priceMxn || 20) + ' MXN por foto'}</p>
    <div class="row"><button class="primary search-all-btn" style="width:100%">Buscar por selfie o dorsal</button></div>
    <p id="evFaceStatus" class="muted"></p>
    ${r.photos.length === 0 ? `<div class="card" id="notifyCard"><h3>¿Todavía no hay fotos?</h3><p class="muted">Déjanos tu correo y te avisamos en cuanto el fotógrafo suba las fotos de este evento. Solo un correo, sin spam.</p><div class="row"><input id="notifyEmail" type="email" placeholder="Tu correo" style="flex:1"><button id="notifyBtn" class="primary">Avísame cuando haya fotos</button></div><p id="notifyStatus" class="muted"></p></div>` : ''}
    <div class="grid" id="evGrid">${r.photos.map(p => photoCard(p, { delete: true, event: r.event })).join('') || '<p>No hay fotos todavía.</p>'}</div>`;
  bindPhotos(r.photos);
  trackView('event', null, eventId);
  const notifyBtn = $('#notifyBtn');
  if (notifyBtn) notifyBtn.onclick = async () => {
    const email = ($('#notifyEmail').value || '').trim();
    const st = $('#notifyStatus');
    if (st) st.textContent = 'Guardando…';
    try {
      const res = await api('/api/subscribe-photo-alert', { method: 'POST', body: JSON.stringify({ eventId, email }) });
      if (st) st.textContent = res.hasPhotos ? 'Este evento ya tiene fotos, búscalas arriba.' : 'Listo. Te avisamos a ' + email + ' en cuanto haya fotos.';
    } catch (e) { if (st) st.textContent = e.message; }
  };
  const joinBtn = $('#joinBtn');
  if (joinBtn) joinBtn.onclick = async () => {
    try {
      await api('/api/join-event', { method: 'POST', body: JSON.stringify({ eventId, priceMxn: Number($('#joinPrice').value || 20) }) });
      loadEventDetail(eventId);
    } catch (e) { const st = $('#joinStatus'); if (st) st.textContent = e.message; }
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
  $('#myPhotosList').innerHTML = r.photos.length ? `<div class="grid">${r.photos.map(p => photoCard(p, { remove: true })).join('')}</div>` : '<p>Todavía no tienes fotos guardadas.</p>';
  bindPhotos(r.photos);
  // Quitar de Mis fotos: solo la saca de TU lista (la foto sigue en el
  // evento). Solo sale en las gratis: las de pago no se pueden quitar,
  // porque si se quitara perderías una foto que ya pagaste.
  document.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.remove);
    if (!confirm('¿Quitar esta foto de Mis fotos? Solo se quita de tu lista; la foto sigue en el evento.')) return;
    try { await api('/api/remove-download', { method: 'POST', body: JSON.stringify({ photoId: id }) }); loadMyPhotos(); }
    catch (e) { alert(e.message); }
  });
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
  // Todas las peticiones del panel salen A LA VEZ: antes iban una por
  // una, esperando cada respuesta, y el panel tardaba 10-20 s en abrir.
  // Ahora el tiempo total es más o menos el de la petición más lenta.
  // Iconos del panel en lista (SVG simples en dorado, sin emoji).
  const pIco = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0 5 5m-5-5L7 9"/><path d="M4 20h16"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11V4h7l10 10-7 7L3 11z"/><circle cx="8" cy="9" r="1.6" fill="currentColor" stroke="none"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M17.5 15.4c2 .7 3.4 2.2 3.9 4.6"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18M16 15h2"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 8l-4 4 4 4M6 12h10"/></svg>',
  };
  const panelRow = (icon, label, onclick, danger) => `<button type="button" class="panel-row${danger ? ' danger' : ''}" onclick="${onclick}"><span class="panel-ico">${pIco[icon]}</span><span class="panel-label">${label}</span><span class="panel-chev">›</span></button>`;
  // Inicio del panel en lista (se usa en el dibujo rápido y en el
  // completo: es el mismo marcado, para que no se desincronice).
  const panelHomeHtml = (dueCount) => `
    <div id="panelListHome">
    ${dueCount ? `<p class="error">● Tienes ${dueCount} pago(s) a fotógrafos vencido(s) (72 h). Revisa la pestaña "Fotógrafos".</p>` : ''}
    <div class="panel-sec">PANEL FOTÓGRAFO</div>
    <div class="panel-list">
    ${panelRow('plus', 'Crear evento', "goPanelSection('gestion','secCrearEvento')")}
    ${panelRow('upload', 'Subir fotos', "goPanelSection('gestion','secSubirFotos')")}
    ${panelRow('grid', 'Mis eventos', "goPanelSection('gestion','secMisEventos')")}
    ${panelRow('tag', 'Fotos vendidas', "goPanelSection('ventas')")}
    </div>
    <div class="panel-sec">VENTAS Y ESTADÍSTICAS</div>
    <div class="panel-list">
    ${panelRow('chart', 'Estadísticas', "goPanelSection('estadisticas')")}
    ${me.isOwner ? panelRow('users', 'Fotógrafos', "goPanelSection('fotografos')") : panelRow('wallet', 'Mis ganancias', "goPanelSection('ganancias')")}
    ${panelRow('gear', 'Gestión', "goPanelSection('gestion')")}
    </div>
    <div class="panel-sec">CUENTA</div>
    <div class="panel-list">
    ${panelRow('logout', 'Cerrar sesión', 'doLogout()', true)}
    </div>
    </div>
  `;
  // El panel abre AL INSTANTE con la lista y las secciones en
  // "Cargando…": los datos llegan después (8 llamadas en paralelo) y
  // solo entonces se dibuja el contenido. Antes la lista no aparecía
  // hasta que TODO cargaba y el panel tardaba varios segundos en abrir.
  const homeBefore = document.getElementById('panelListHome');
  const panelWasOpen = !!homeBefore && homeBefore.classList.contains('hidden');
  box.innerHTML = panelHomeHtml(0) +
    '<button type="button" id="panelBack" class="panel-back hidden" onclick="showPanelHome()">‹ Panel fotógrafo</button>' +
    [['gestion', 'Gestión'], ['ventas', 'Fotos vendidas'], ['ganancias', 'Mis ganancias'], ['fotografos', 'Fotógrafos'], ['estadisticas', 'Estadísticas']].map(([t, title]) => `<section data-tabpanel="${t}" class="hidden"><h2 class="sec-title">${title}</h2><p class="muted">Cargando…</p></section>`).join('');
  // Todas las peticiones del panel salen A LA VEZ: antes iban una por
  // una, esperando cada respuesta, y el panel tardaba 10-20 s en abrir.
  // Ahora el tiempo total es más o menos el de la petición más lenta.
  // Cada llamada del panel tiene su propio tiempo límite (10 s) y su
  // respaldo: el 2026-11-18 /api/events no contestó en 300 s y, como era
  // la única llamada sin respaldo, el Promise.all nunca se resolvió y
  // todas las secciones se quedaron en "Cargando…". Ahora una llamada
  // atorada ya no puede congelar el panel: vence a los 10 s, usa su
  // respaldo y la sección afectada avisa con Reintentar.
  const panelFailed = {};
  const panelApi = (path, fallback, key) => api(path, { timeoutMs: 10000 }).catch(() => { panelFailed[key] = true; return fallback; });
  const panelResults = await Promise.all([
    panelApi('/api/events', { events: [] }, 'events'),
    panelApi('/api/sales', { sales: [], totalDownloads: 0, freeDownloads: 0, revenue: 0 }, 'sales'),
    panelApi('/api/stats', { totals: { photoViews: 0, uniqueViewers: 0, eventViews: 0, totalDownloads: 0, freeDownloads: 0, revenue: 0 }, events: [], topPhotos: [], topBibs: [] }, 'stats'),
    panelApi('/api/my-earnings', null, 'earnings'),
    me.isOwner ? panelApi('/api/payouts-summary', null, 'payouts') : Promise.resolve(null),
    me.isOwner ? panelApi('/api/payouts-history', { payouts: [] }, 'payoutHistory') : Promise.resolve({ payouts: [] }),
    me.isOwner ? panelApi('/api/list-photographers', { photographers: [] }, 'photographers') : Promise.resolve({ photographers: [] }),
    me.isOwner ? panelApi('/api/list-applications', { applications: [] }, 'applications') : Promise.resolve({ applications: [] }),
  ]).catch(() => null);
  const panelFailedAny = Object.keys(panelFailed).length > 0;
  if (!panelResults) {
    box.innerHTML = panelHomeHtml(0) +
      '<button type="button" id="panelBack" class="panel-back hidden" onclick="showPanelHome()">‹ Panel fotógrafo</button>' +
      '<p class="error">No se pudo cargar el panel. Revisa tu conexión.</p><button class="primary" onclick="loadPhotographer()">Reintentar</button>';
    return;
  }
  const [eventsRes, sales, stats, earnings, payouts, payoutHistory, photographers, applications] = panelResults;
  const events = eventsRes.events;
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
  // Cuenta pendiente de aprobación: no puede crear eventos ni vender
  // todavía. Sí puede dejar su CLABE de pagos y ver sus ganancias (en
  // ceros hasta que venda).
  if (!approved) {
    box.innerHTML = `
    <p class="error">Tu cuenta de fotógrafo está pendiente de aprobación por ONLYCLICK. En cuanto te aprueben podrás crear eventos y subir fotos.</p>
    <div class="panel-sec">Clabe para recibir tus pagos</div>
    <div class="sec-card">
    <p class="muted">Cuando vendas fotos, ONLYCLICK te manda tu parte a esta CLABE cada 72 horas. Son 18 dígitos.</p>
    <div class="sec-field"><label class="sec-label" for="payClabe">Tu CLABE (18 dígitos)</label><input id="payClabe" inputmode="numeric" placeholder="Tu CLABE (18 dígitos)" value="${esc(me.payoutClabe || '')}"></div>
    <button id="paySave" class="primary sec-btn-gold">Guardar CLABE</button>
    <p id="payStatus" class="muted"></p>
    </div>
    <div class="panel-sec">Mis ganancias</div>
    <div class="sec-card">
    ${earnings ? `<div class="sec-kv"><span>Total vendido</span><span class="sec-val">${fmtMxn(earnings.totalSold)}</span></div><div class="sec-kv"><span>Mi parte pendiente</span><span class="sec-val">${fmtMxn(earnings.pendingBalance)}</span></div><div class="sec-kv"><span>Ya me pagaron</span><span class="sec-val">${fmtMxn(earnings.paidShare)}</span></div>` : '<p class="muted">Sin datos todavía.</p>'}
    </div>`;
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
    <div class="sec-subcard">
      <p><strong>${esc(a.name)}</strong> · ${esc(a.city)} · <span class="muted">${String(a.createdAt || '').slice(0, 10)}</span></p>
      <p class="muted">WhatsApp: ${esc(a.phone)} · Eventos: ${esc(a.events)}</p>
      <p class="muted">Cámara: ${esc(a.camera || '—')} · Especialidad: ${esc(a.specialty || '—')}</p>
      <p class="muted">Experiencia con dorsal: ${esc(a.dorsalExp || '—')} · Disponibilidad: ${esc(a.availability || '—')}</p>
      <p class="muted">CLABE para pagos: ${esc(a.clabe || '—')}</p>
      <p class="muted">Trabajo: <a href="${esc(a.sampleLink)}" target="_blank" rel="noopener">${esc(a.sampleLink)}</a></p>
      ${a.message ? `<p class="muted">Mensaje: ${esc(a.message)}</p>` : ''}
      <div class="sec-actions">${withActions ? `<button data-app-approve="${a.id}" class="primary">Aprobar</button> <button data-app-reject="${a.id}">Rechazar</button>` : appInviteHtml(a)}</div>
    </div>`;
  const solicitudesHtml = me.isOwner ? `
    <div class="panel-sec">Solicitudes</div>
    <div class="sec-card">
    <p class="muted">Fotógrafos que llenaron el formulario del inicio. Aprueba al que te guste y se le genera un link para crear su cuenta; si no te convence, recházalo.</p>
    ${appsPending.length || appsOpen.length ? `<div data-pg="applications">${appsPending.map(a => appCard(a, true)).join('')}${appsOpen.map(a => appCard(a, false)).join('')}</div><div data-pg-controls="applications"></div>` : '<p class="muted">No hay solicitudes pendientes.</p>'}
    ${appsReviewed.length ? `<details><summary>Revisadas (${appsReviewed.length})</summary>${appsReviewed.map(a => `<p class="muted">${esc(a.name)} · ${a.status === 'approved' ? 'Aprobada' : 'Rechazada'} · ${String(a.createdAt || '').slice(0, 10)}</p>`).join('')}</details>` : ''}
    </div>` : '';
  // Al recargar el panel las listas vuelven a la página 1 (la pestaña
  // activa sí se recuerda mientras se navega).
  panelPages = {};
  const panelTabs = me.isOwner
    ? [['ventas', 'Ventas'], ['estadisticas', 'Estadísticas'], ['fotografos', 'Fotógrafos'], ['gestion', 'Gestión']]
    : [['ventas', 'Ventas'], ['estadisticas', 'Estadísticas'], ['ganancias', 'Mis ganancias'], ['gestion', 'Gestión']];
  if (!panelTabs.some(t => t[0] === panelTab)) panelTab = 'ventas';
  // "Mis ganancias" es el mismo bloque para todos: el dueño lo ve dentro
  // de la pestaña Fotógrafos y los demás fotógrafos en su propia pestaña.
  // Fila etiqueta / valor (el total en dorado), como en el resto de las
  // secciones acomodadas.
  const kv = (label, value, gold) => `<div class="sec-kv"><span>${label}</span><span class="sec-val${gold ? ' gold' : ''}">${value}</span></div>`;
  const earningsHtml = earnings ? `${kv('Total vendido', fmtMxn(earnings.totalSold))}${kv('Comisión Clip', fmtMxn(earnings.clipFee))}${kv('Comisión ONLYCLICK (10%)', fmtMxn(earnings.orlanFee))}${kv('Mi parte', fmtMxn(earnings.photographerShare), true)}${kv('Pendiente por pagarme', fmtMxn(earnings.pendingBalance))}${kv('Ya me pagaron', fmtMxn(earnings.paidShare))}${earnings.lastPayout ? kv('Último pago', fmtMxn(earnings.lastPayout.amountMxn) + ' el ' + String(earnings.lastPayout.paidAt || '').slice(0, 10)) : ''}<p class="muted">ONLYCLICK te paga tu parte cada 72 horas a tu CLABE. Clip quita 4.18% primero y ONLYCLICK se queda el 10% de lo que queda.</p>` : '<p class="muted">Sin datos todavía.</p>';
  // Fila de un evento propio en "Mis eventos": encabezado con nombre y
  // resumen; los controles (precio, dorsales, ocultar, eliminar) salen
  // debajo al picarla. Cada fila es UN hijo de [data-pg="events"], así
  // la paginación de 10 por página sigue contando eventos, no controles.
  const eventRowHtml = e => `
    <div class="sec-ev">
      <button type="button" class="sec-ev-head" onclick="toggleEventRow(this)">
        <span class="sec-ev-name"><strong>${esc(e.name)}</strong> ${e.isHidden ? '<span class="badge">Oculto</span>' : ''} ${e.isExclusive ? '<span class="badge official">Exclusivo OnlyClick</span>' : ''} ${e.isUpcoming ? '<span class="badge official">Próximo evento</span>' : ''}<br><span class="muted">${e.photoCount || 0} foto(s) · ${e.freeMode ? 'Gratis' : 'De pago'}${(e.freeMode || e.isExclusive) ? '' : ' · $' + Number(e.priceMxn || 20)}</span></span>
        <span class="sec-chev">›</span>
      </button>
      <div class="sec-ev-body hidden">
        ${e.isExclusive ? '' : `<button data-free="${e.id}">${e.freeMode ? 'Cambiar a pago' : 'Cambiar a gratis'}</button>`}
        ${e.freeMode ? '' : `<div class="sec-field"><span class="muted">Precio por foto: $</span> <input type="number" data-price="${e.id}" value="${Number(e.priceMxn || 20)}" min="1" max="5000" style="width:90px;display:inline-block"> <button data-saveprice="${e.id}">Guardar precio</button></div>`}
        <div class="sec-actions"><button data-rev="${e.id}">Revisar dorsales</button>${me.isOwner ? ` <button data-hide="${e.id}">${e.isHidden ? 'Mostrar álbum' : 'Ocultar álbum'}</button> <button data-upcoming="${e.id}">${e.isUpcoming ? 'Quitar “Próximo evento”' : 'Marcar como próximo evento'}</button>` : ''} <button data-del="${e.id}">Eliminar evento</button></div>
      </div>
    </div>`;
  const joinedRowHtml = e => `
    <div class="sec-joined">
      <p><strong>${esc(e.name)}</strong> — ${e.photoCount || 0} foto(s) · ${e.freeMode ? 'Gratis' : 'De pago'}</p>
      <div class="sec-inline"><span class="muted">Mi precio: $</span><input type="number" data-myprice="${e.id}" value="${Number(e.myPrice || e.priceMxn || 20)}" min="1" max="5000" style="width:90px;display:inline-block"> <button data-savemyprice="${e.id}">Guardar mi precio</button> <button data-leave="${e.id}">Salir del evento</button></div>
    </div>`;
  // ¿El usuario abrió una sección MIENTRAS cargaba? El esqueleto se
  // reemplaza aquí: si la lista está oculta es que hay una sección
  // abierta y hay que restaurarla al final (panelWasOpen, de arriba,
  // solo cubre la sección abierta ANTES de empezar a cargar).
  const _homeNow = document.getElementById('panelListHome');
  const panelOpenedWhileLoading = !!_homeNow && _homeNow.classList.contains('hidden');
  box.innerHTML = `
    ${panelHomeHtml(dueCount)}
    ${panelFailedAny ? '<p class="error">Algunos datos del panel no se pudieron cargar: el servidor tardó demasiado en responder.</p><button class="primary" onclick="loadPhotographer()">Reintentar</button>' : ''}
    <button type="button" id="panelBack" class="panel-back hidden" onclick="showPanelHome()">‹ Panel fotógrafo</button>
    <section data-tabpanel="gestion">
    <h2 class="sec-title">Gestión</h2>
    <div class="panel-sec" id="secCrearEvento">Crear evento</div>
    <div class="sec-card">
    <div class="sec-field"><label class="sec-label" for="evName">Nombre del evento</label><input id="evName" placeholder="Nombre del evento (ej. Ensenada medio)"></div>
    <div class="sec-row3">
      <div class="sec-field"><label class="sec-label" for="evSport">Deporte</label><input id="evSport" placeholder="Deporte" value="Carrera"></div>
      <div class="sec-field"><label class="sec-label" for="evDate">Fecha</label><input id="evDate" type="date"></div>
      <div class="sec-field"><label class="sec-label" for="evPlace">Lugar</label><input id="evPlace" placeholder="Lugar"></div>
    </div>
    ${me.isOwner ? `<label class="sec-check"><input id="evExclusive" type="checkbox"><span><strong>Álbum exclusivo OnlyClick</strong><br><span class="muted">Solo yo subo fotos, gratis para los participantes. Para cuando un organizador te contrata: él te paga directo y ningún otro fotógrafo puede unirse ni vender en este álbum.</span></span></label>` : ''}
    ${me.isOwner ? `<label class="sec-check"><input id="evUpcoming" type="checkbox"><span><strong>Próximo evento (aún sin fotos)</strong><br><span class="muted">Se publica la portada, el título y la fecha con la etiqueta "Próximo evento", sin precio y sin abrirse. Cuando subas las fotos, quítalo en Gestión y el álbum se vuelve normal.</span></span></label>` : ''}
    <button id="evCreate" class="primary sec-btn-gold">Crear evento</button>
    </div>
    <div class="panel-sec">Nombre en tus fotos</div>
    <div class="sec-card">
    <p class="muted">Así sale en cada foto: "Foto de …". Puede ser tu primer nombre, un apodo o el nombre de tu marca o página. Si lo dejas vacío, sale tu primer nombre.</p>
    <div class="sec-field"><label class="sec-label" for="displayName">Nombre</label><input id="displayName" placeholder="Ej. Only Dust" value="${esc(me.displayName || '')}" maxlength="40"></div>
    <button id="displaySave" class="primary sec-btn-gold">Guardar nombre</button>
    <p id="displayStatus" class="muted"></p>
    </div>
    <div class="panel-sec">Clabes</div>
    <div class="sec-card">
    <div class="sec-subhead">Cooperación voluntaria</div>
    <p class="muted">Si pones tu CLABE aquí, al descargar una foto gratis les aparecerá un mensaje invitándolos a cooperar. La CLABE solo sirve para recibir depósitos.</p>
    ${tipBlocked ? '<p class="muted">Tus álbumes son de pago, así que la cooperación voluntaria está desactivada. Si cambias un álbum a gratis, se activa de nuevo.</p>' : ''}
    <div class="sec-field"><label class="sec-label" for="tipClabe">Tu CLABE (18 dígitos)</label><input id="tipClabe" inputmode="numeric" placeholder="Tu CLABE (18 dígitos)" value="${esc(me.tipClabe || '')}"${tipBlocked ? ' disabled' : ''}></div>
    <button id="tipSave" class="primary sec-btn-gold"${tipBlocked ? ' disabled' : ''}>Guardar CLABE</button>
    <p id="tipStatus" class="muted"></p>
    <div class="sec-divider"></div>
    <div class="sec-subhead">CLABE para recibir tus pagos</div>
    <p class="muted">Cuando vendas fotos, ONLYCLICK te manda tu parte (90% de lo que queda después de Clip) a esta CLABE cada 72 horas. Son 18 dígitos.</p>
    <div class="sec-field"><label class="sec-label" for="payClabe">Tu CLABE (18 dígitos)</label><input id="payClabe" inputmode="numeric" placeholder="Tu CLABE (18 dígitos)" value="${esc(me.payoutClabe || '')}"></div>
    <button id="paySave" class="primary sec-btn-gold">Guardar CLABE</button>
    <p id="payStatus" class="muted"></p>
    </div>
    <div class="panel-sec" id="secSubirFotos">Subir fotos</div>
    <div class="sec-card">
    <div class="sec-field"><label class="sec-label" for="upEvent">Evento</label><select id="upEvent">${myEvents.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}${joinedEvents.map(e => `<option value="${e.id}">${esc(e.name)} · participas</option>`).join('')}</select></div>
    <div class="sec-field"><label class="sec-label" for="upFiles">Fotos</label><input id="upFiles" type="file" accept="image/*" multiple></div>
    <div class="sec-field"><label class="sec-label" for="upPrice">Precio por foto (MXN)</label><input id="upPrice" type="number" placeholder="Precio por foto en MXN (0 si es gratis)" value="0"></div>
    <div id="upList"></div>
    <p id="upStatus" class="muted"></p>
    <button id="upBtn" class="primary sec-btn-gold">Subir fotos</button>
    <p class="muted">Al terminar de subirse, los dorsales se leen solos con IA y se guardan. Si alguna queda sin dorsal, usa "Leer dorsales en lote" en Revisar dorsales.</p>
    </div>
    <div class="panel-sec">Portada del evento</div>
    <div class="sec-card">
    <p class="muted">Una foto aparte que se ve en la lista de eventos. Elige el evento y sube la foto.</p>
    <div class="sec-field"><label class="sec-label" for="covEvent">Evento</label><select id="covEvent">${myEvents.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></div>
    <div class="sec-field"><label class="sec-label" for="covFile">Foto de portada</label><input id="covFile" type="file" accept="image/*"></div>
    <div id="covPreview"></div>
    <button id="covBtn" class="primary sec-btn-gold">Subir portada</button>
    <p id="covStatus" class="muted"></p>
    </div>
    <div class="panel-sec" id="secMisEventos">Mis eventos</div>
    <div class="sec-card">
    ${panelFailed.events ? '<p class="error">No se pudieron cargar tus eventos: el servidor tardó demasiado en responder.</p><button class="primary" onclick="loadPhotographer()">Reintentar</button>' : ''}
    <div data-pg="events">${panelFailed.events ? '' : (myEvents.map(e => eventRowHtml(e)).join('') || '<p>Sin eventos.</p>')}</div>
    <div data-pg-controls="events"></div>
    </div>
    ${joinedEvents.length ? `<div class="panel-sec">Eventos en los que participo</div>
    <div class="sec-card">
    <p class="muted">Eventos de otros fotógrafos donde subes tus fotos a tu precio. El creador del evento maneja si es gratis o de pago.</p>
    <div data-pg="joined">${joinedEvents.map(e => joinedRowHtml(e)).join('')}</div>
    <div data-pg-controls="joined"></div>
    </div>` : ''}
    <div class="panel-sec">Revisar dorsales</div>
    <div class="sec-card">
    <div id="revList"></div>
    <p class="muted">Revisar dorsales muestra las fotos ya subidas de un evento: corrige el número o vuelve a leerlo con IA sin volver a subir la foto.</p>
    </div>
    </section>
    <section data-tabpanel="ventas">
    <h2 class="sec-title">Fotos vendidas</h2>
    <div class="panel-sec">Resumen</div>
    <div class="sec-card">
    ${kv('Total descargas', sales.totalDownloads)}${kv('Gratis', sales.freeDownloads)}${kv('Ingresos por ventas', '$' + sales.revenue + ' MXN', true)}
    </div>
    <div class="panel-sec">Ventas</div>
    <div class="sec-card">
    <div data-pg="sales">${sales.sales.map(s => `<div class="sec-sale"><span><strong>${esc(s.eventName)}</strong><br><span class="muted">Dorsal ${esc((s.bibs || []).join(', '))} · ${esc(s.buyerName)}</span></span><span class="sec-val gold">$${s.amount}</span></div>`).join('') || '<p class="muted">Sin ventas todavía.</p>'}</div>
    <div data-pg-controls="sales"></div>
    </div>
    </section>
    ${me.isOwner ? '' : `<section data-tabpanel="ganancias">
    <h2 class="sec-title">Mis ganancias</h2>
    <div class="panel-sec">Mis ganancias</div>
    <div class="sec-card">
    ${earningsHtml}
    </div>
    </section>`}
    ${me.isOwner && payouts ? `<section data-tabpanel="fotografos">
    <h2 class="sec-title">Fotógrafos</h2>
    <div class="panel-sec">Mis ganancias</div>
    <div class="sec-card">
    ${earningsHtml}
    </div>
    <div class="panel-sec">Pagos a fotógrafos</div>
    <div class="sec-card">
    <p class="muted">Todo el dinero cae en tu cuenta de Clip. Cada 72 horas desde la primera venta sin pagar, el pago se vence y sale en rojo. Mándale el dinero a su CLABE y luego marca "Pagado".</p>
    ${kv('Vendido', fmtMxn(payouts.totals.totalSold))}${kv('Clip', fmtMxn(payouts.totals.clipFee))}${kv('Tu comisión (10%)', fmtMxn(payouts.totals.orlanFee))}${kv('Para fotógrafos', fmtMxn(payouts.totals.photographerShare))}${kv('Pendiente por pagar', fmtMxn(payouts.totals.pendingBalance), true)}
    <div data-pg="payouts">${(payouts.photographers || []).length ? (payouts.photographers || []).map(p => `
    <div class="sec-subcard">
      <p><strong>${esc(p.name)}</strong> ${p.approved ? '<span class="sec-pill">Aprobada</span>' : '<span class="error">(pendiente de aprobación)</span>'} · ${esc(p.email)}</p>
      ${kv('Vendido', fmtMxn(p.totalSold))}${kv('Clip', fmtMxn(p.clipFee))}${kv('Tu comisión', fmtMxn(p.orlanFee))}${kv('Su parte', fmtMxn(p.photographerShare), true)}${kv('Pendiente por pagarle', fmtMxn(p.pendingBalance), true)}
      <p>${p.pendingSince ? (p.isDue ? `<span class="sec-danger">● PAGO VENCIDO — vence desde ${String(p.dueAt || '').slice(0, 10)}</span>` : `<span class="muted">Próximo pago en ${p.hoursUntilDue} h</span>`) : '<span class="muted">Sin ventas pendientes.</span>'}</p>
      <p class="muted">CLABE para pagarle: ${p.payoutClabe ? `<strong>${esc(p.payoutClabe)}</strong> <button data-copyclabe="${esc(p.payoutClabe)}">Copiar CLABE</button>` : '<span class="error">El fotógrafo aún no pone su CLABE.</span>'}</p>
      ${p.lastPayout ? `<p class="muted">Último pago: ${fmtMxn(p.lastPayout.amountMxn)} el ${String(p.lastPayout.paidAt || '').slice(0, 10)}</p>` : ''}
      <button data-pay="${p.photographerId}" class="primary sec-btn-gold" ${p.pendingBalance > 0 ? '' : 'disabled'}>Marcar como pagado</button>
    </div>`).join('') : '<p class="muted">Todavía no hay otros fotógrafos.</p>'}</div>
    <div data-pg-controls="payouts"></div>
    ${(payoutHistory && payoutHistory.payouts && payoutHistory.payouts.length) ? `<div class="panel-sec">Historial de pagos enviados</div><div data-pg="history">` + payoutHistory.payouts.map(h => `<div class="sec-kv"><span>${esc(h.photographerName)}</span><span class="sec-val">${fmtMxn(h.amountMxn)} · ${String(h.paidAt || h.createdAt || '').slice(0, 10)}</span></div>`).join('') + `</div><div data-pg-controls="history"></div>` : ''}
    </div>
    ${solicitudesHtml}
    <div class="panel-sec">Fotógrafos</div>
    <div class="sec-card">
    <p class="muted">Aprueba a los fotógrafos nuevos para que puedan crear eventos y vender. Solo tú ves esta lista.</p>
    <div data-pg="photogs">${(photographers && photographers.photographers && photographers.photographers.length) ? photographers.photographers.map(ph => `<div class="sec-photog"><strong>${esc(ph.name)}</strong> · ${esc(ph.email)} · ${ph.eventCount || 0} evento(s) · Vendido: ${fmtMxn(ph.totalSold)} · ${ph.isOwner ? '<span class="muted">Dueño</span>' : (ph.approved ? '<span class="ok">Aprobado</span>' : '<span class="error">Pendiente</span>')} ${(!ph.isOwner && !ph.hasApplication) ? '<span class="error">Sin solicitud</span>' : ''} ${ph.isOwner ? '' : (ph.approved ? `<button data-reject="${ph.id}">Quitar aprobación</button>` : `<button data-approve="${ph.id}" class="primary">Aprobar</button>`)}</div>`).join('') : '<p class="muted">No hay fotógrafos registrados.</p>'}</div>
    <div data-pg-controls="photogs"></div>
    </div>
    </section>` : ''}
    <section data-tabpanel="estadisticas">
    <h2 class="sec-title">Estadísticas</h2>
    ${(stats.totals.photoViews || stats.totals.eventViews || stats.totals.totalDownloads)
      ? `<div class="panel-sec">Resumen</div>
    <div class="sec-card">
    ${kv('Vistas de fotos', stats.totals.photoViews)}${kv('Visitantes únicos', stats.totals.uniqueViewers)}${kv('Visitas a eventos', stats.totals.eventViews)}${kv('Descargas', stats.totals.totalDownloads)}${kv('Ingresos', '$' + stats.totals.revenue + ' MXN', true)}
    </div>
    <div class="panel-sec">Por evento</div>
    <div class="sec-card">
    <div data-pg="statsevents">${(stats.events || []).map(e => `<div class="sec-stat"><strong>${esc(e.name)}</strong><br><span class="muted">Vistas: ${e.photoViews} · Visitantes: ${e.uniqueViewers} · Visitas al evento: ${e.eventViews} · Descargas: ${e.downloads} · $${e.revenue} MXN</span></div>`).join('')}</div>
    <div data-pg-controls="statsevents"></div>
    </div>
    <div class="panel-sec">Fotos más vistas</div>
    <div class="sec-card">
    ${(stats.topPhotos || []).length ? (stats.topPhotos || []).map(p => `<div class="sec-top"><img src="${photoImgUrl(p.photoId, true)}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:6px;vertical-align:middle"> <span><strong>Dorsal ${esc((p.bibs || []).join(', ') || 'sin dorsal')}</strong><br><span class="muted">${esc(p.eventName)} · ${p.views} vista(s) · ${p.downloads} descarga(s)</span></span></div>`).join('') : '<p class="muted">Sin vistas todavía.</p>'}
    </div>
    <div class="panel-sec">Dorsales más buscados</div>
    <div class="sec-card">
    ${(stats.topBibs || []).length ? (stats.topBibs || []).map(b => kv('Dorsal ' + esc(b.bib), b.searches + ' búsqueda(s)')).join('') : '<p class="muted">Sin búsquedas todavía.</p>'}
    </div>`
      : '<p class="muted">Todavía no hay vistas registradas. Se empiezan a contar desde hoy.</p>'}
    </section>`;
  $('#evCreate').onclick = async () => {
    try { await api('/api/event-create', { method: 'POST', body: JSON.stringify({ name: $('#evName').value, sport: $('#evSport').value, eventDate: $('#evDate').value, location: $('#evPlace').value, isExclusive: !!($('#evExclusive') && $('#evExclusive').checked), isUpcoming: !!($('#evUpcoming') && $('#evUpcoming').checked) }) }); alert('Evento creado.'); loadPhotographer(); loadEvents(); } catch (e) { alert(e.message); }
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
  function renderCovPreview() { const ev = events.find(e => e.id === Number($('#covEvent').value)); $('#covPreview').innerHTML = ev && ev.coverPath ? `<img src="${coverImgUrl(ev.id)}&t=${Date.now()}" alt="" style="width:100%;max-height:180px;object-fit:cover;border-radius:8px">` : '<p class="muted">Este evento aún no tiene portada.</p>'; }
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
  // Álbum exclusivo: el precio por foto no aplica (gratis). Al elegir un
  // álbum exclusivo, el precio se fija en 0 y el campo se deshabilita.
  $('#upEvent').onchange = () => {
    const ev = events.find(e => e.id === Number($('#upEvent').value));
    const excl = !!(ev && ev.isExclusive);
    $('#upPrice').disabled = excl;
    if (excl) { $('#upPrice').value = 0; $('#upStatus').textContent = 'Álbum exclusivo OnlyClick: las fotos son gratis.'; }
    else if ($('#upStatus').textContent.includes('Álbum exclusivo')) $('#upStatus').textContent = '';
  };
  $('#upEvent').onchange();
  $('#upBtn').onclick = async () => {
    const files = upRows.length ? upRows : [...$('#upFiles').files].map(f => ({ file: f, bibs: '' }));
    if (!files.length) return alert('Elige al menos una foto.');
    const eventId = Number($('#upEvent').value);
    if (!eventId) return alert('Primero crea un evento.');
    const upEv = events.find(e => e.id === eventId);
    // Álbum exclusivo: solo el dueño sube fotos (el servidor también lo
    // bloquea; esto es solo para avisar antes de subir).
    if (upEv && upEv.isExclusive && !me.isOwner) return alert('Este álbum es exclusivo OnlyClick: solo el dueño sube fotos.');
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
        // Metadatos de la foto para la vista ampliada (resolución y
        // tamaño): se guardan con la foto; si no se pueden leer, la
        // subida sigue igual y la vista ampliada los calcula después.
        let widthPx = null, heightPx = null;
        try { const dims = await imageSize(small); widthPx = dims.w; heightPx = dims.h; } catch (_) {}
        const sizeKb = Math.max(1, Math.round((b64.length * 3 / 4) / 1024));
        let thumbB64 = '';
        try {
          const thumb = await downscale(dataUrl, 400, 0.8);
          if (thumb && thumb.startsWith('data:image/jpeg') && thumb.length < small.length) thumbB64 = thumb.split(',')[1];
        } catch (_) {}
        const bibs = String(row.bibs || '').split(',').map(s => s.trim()).filter(Boolean);
        await api('/api/photo-upload', { method: 'POST', body: JSON.stringify({ eventId, filename: row.file.name, mimeType: 'image/jpeg', dataBase64: b64, thumbBase64: thumbB64, bibs, price: (upEv && upEv.isExclusive) ? 0 : Number($('#upPrice').value || 0), widthPx, heightPx, sizeKb }) });
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
  // Ocultar/mostrar álbum (solo el dueño, solo sus álbumes): se actualiza
  // el panel y las listas sin recargar la página entera.
  document.querySelectorAll('[data-hide]').forEach(b => b.onclick = async () => {
    const ev = events.find(e => e.id === Number(b.dataset.hide));
    try { await api('/api/set-event-hidden', { method: 'POST', body: JSON.stringify({ eventId: ev.id, isHidden: !ev.isHidden }) }); loadPhotographer(); loadEvents(); } catch (e) { alert(e.message); }
  });
  // Marcar/quitar "Próximo evento" (solo el dueño, solo sus álbumes):
  // se actualiza el panel y las listas sin recargar la página entera.
  document.querySelectorAll('[data-upcoming]').forEach(b => b.onclick = async () => {
    const ev = events.find(e => e.id === Number(b.dataset.upcoming));
    try { await api('/api/set-event-upcoming', { method: 'POST', body: JSON.stringify({ eventId: ev.id, isUpcoming: !ev.isUpcoming }) }); loadPhotographer(); loadEvents(); } catch (e) { alert(e.message); }
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
      box.innerHTML = '<h4>' + esc(r.event.name) + ' — ' + r.photos.length + ' foto(s)</h4><button id="batchRead" class="primary">Leer dorsales en lote (IA)</button> <span id="batchStatus" class="muted"></span>' + (me && me.isOwner ? ' <button id="backfillThumbs" class="secondary">Generar miniaturas</button> <span id="backfillStatus" class="muted"></span>' : '') + (r.photos.length > 100 ? '<p class="muted">Mostrando 100 de ' + r.photos.length + ' fotos — el lote procesa todas.</p>' : '') + r.photos.slice(0, 100).map(p => `
        <div class="row" style="align-items:center">
          <img src="${photoImgUrl(p.id, true)}" loading="lazy" decoding="async" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px">
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
      // Generar miniaturas (solo el dueño): las fotos viejas no tienen
      // miniatura y la galería baja la foto completa (~300 KB) por cada
      // vista — eso se comió la cuota de Supabase. El botón llama al
      // endpoint en lotes de 6 hasta terminar; si se cierra la página, lo
      // ya guardado queda y al darle otra vez continúa con las que faltan.
      // La foto original no se toca: solo se crea la copia chiquita.
      const bfBtn = document.getElementById('backfillThumbs');
      if (bfBtn) bfBtn.onclick = async () => {
        bfBtn.disabled = true;
        const bfStatus = document.getElementById('backfillStatus');
        let cursor = 0, done = 0, created = 0, fails = 0, total = 0;
        try {
          for (;;) {
            const r = await api('/api/backfill-thumbs', { method: 'POST', body: JSON.stringify({ eventId: ev.id, limit: 6, cursor }) });
            created += r.created || 0; fails += (r.failed || []).length; done += r.processed || 0; total = done + (r.remaining || 0);
            if (bfStatus) bfStatus.textContent = 'Generando miniaturas… ' + done + '/' + total + (fails ? ' · ' + fails + ' fallaron' : '');
            if (r.done || !r.nextCursor) break;
            cursor = r.nextCursor;
          }
          if (bfStatus) bfStatus.textContent = 'Listo: ' + created + ' miniatura(s) generada(s)' + (fails ? ' · ' + fails + ' fallaron' : '') + '. La galería ya carga fotos chiquitas.';
        } catch (e) {
          if (bfStatus) bfStatus.textContent = 'Error: ' + (e && e.message ? e.message : 'no se pudieron generar las miniaturas');
        } finally { bfBtn.disabled = false; }
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
  // Lista y paginación: se aplican después de cada render del panel.
  // El panel siempre abre en la lista, salvo que el usuario ya hubiera
  // abierto una sección (antes de cargar, o mientras cargaba): ahí se
  // queda donde estaba.
  if ((panelWasOpen || panelOpenedWhileLoading) && document.querySelector(`#photoPanel [data-tabpanel="${panelTab}"]`)) showPanelTab(panelTab); else showPanelHome();
  applyPanelPagination();
}

function showView(v) {
  // Un estado viejo del historial (versión anterior) puede traer una vista
  // que ya no existe ('search', 'photographer'): caer al inicio.
  if (!['home', 'events', 'myphotos', 'account', 'cart', 'notifications'].includes(v)) v = 'home';
  // Notificaciones es para cualquier usuario con sesión (atletas
  // incluidos); sin sesión, caer al inicio.
  if (v === 'notifications' && !me) v = 'home';
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

// ---- Notificaciones: avisos del dueño a los fotógrafos, noticias para
// los atletas y avisos de caducidad para TODOS (atletas incluidos) ----
// El botón se ve para cualquier usuario con sesión (antes solo
// fotógrafos: los atletas no tenían cómo enterarse de que sus fotos
// iban a desaparecer).
function updateNotificationsNav() {
  const show = !!me;
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
// Conteo de no leídos al entrar con sesión (avisos + caducidades). Si
// el endpoint falla, no se rompe nada: el badge queda oculto.
async function refreshNotifBadge() {
  if (!me) { updateNotifBadge(0); return; }
  try { const r = await api('/api/list-announcements'); updateNotifBadge(r.unreadCount || 0); }
  catch (_) { updateNotifBadge(0); }
}
async function loadNotifications() {
  const list = $('#notifList'), status = $('#notifStatus'), form = $('#notifForm');
  if (form) form.style.display = (me && me.isOwner) ? '' : 'none';
  try {
    const r = await api('/api/list-announcements');
    const items = r.announcements || [];
    // Avisos de caducidad primero (atletas y fotógrafos): álbumes que
    // desaparecen en 15 días o menos.
    const warn = (r.expiring || []).map(w => `<div class="card"><strong>El álbum ${esc(w.eventName)} desaparecerá en ${w.daysLeft} día${w.daysLeft === 1 ? '' : 's'}.</strong><p>Descarga tus fotos antes de que se borre.</p></div>`).join('');
    list.innerHTML = (warn + (items.length
      ? items.map(x => `<div class="card"><strong>${esc(x.title)}</strong><p>${esc(x.body).replace(/\n/g, '<br>')}</p><p class="muted">${esc(String(x.createdAt || '').slice(0, 10))}${(me && me.isOwner) ? ' · ' + esc(audienceLabel(x.audience)) : ''}</p></div>`).join('')
      : '')).trim() || '<p>No hay avisos todavía.</p>';
    if (status) status.textContent = '';
    // Al abrirlas ya se vieron: marcar leídas y limpiar el numerito.
    api('/api/mark-announcements-read', { method: 'POST', body: JSON.stringify({}) }).then(() => updateNotifBadge(0)).catch(() => {});
  } catch (e) {
    list.innerHTML = '';
    if (status) status.textContent = 'No se pudieron cargar los avisos. Intenta de nuevo.';
  }
}
// Etiqueta del público de una noticia (solo la ve el dueño en su lista).
function audienceLabel(aud) {
  if (aud === 'athletes') return 'Para atletas';
  if (aud === 'photographers') return 'Para fotógrafos';
  if (aud === 'all') return 'Para todos';
  return 'Para fotógrafos';
}
async function publishAnnouncement() {
  const st = $('#notifFormStatus');
  const title = $('#notifTitle').value.trim();
  const body = $('#notifBody').value.trim();
  const audience = ($('#notifAudience') && $('#notifAudience').value) || 'athletes';
  const sent = { athletes: 'Noticia publicada para los atletas.', photographers: 'Aviso publicado para los fotógrafos.', all: 'Noticia publicada para todos.' };
  try {
    await api('/api/create-announcement', { method: 'POST', body: JSON.stringify({ title, body, audience }) });
    $('#notifTitle').value = '';
    $('#notifBody').value = '';
    if ($('#notifAudience')) $('#notifAudience').value = 'athletes';
    if (st) st.textContent = sent[audience] || sent.athletes;
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
// Modal de búsqueda: un solo botón en inicio, evento y cierre de página.
document.addEventListener('click', (e) => { if (e.target.closest('.search-all-btn')) openSearchModal(); if (e.target.closest('#exploreEventsBtn')) showView('events'); });
const searchModalClose = $('#searchModalClose');
if (searchModalClose) searchModalClose.onclick = closeSearchModal;
const searchModalEl = $('#searchModal');
if (searchModalEl) searchModalEl.addEventListener('click', (e) => { if (e.target === searchModalEl) closeSearchModal(); });
// Documentos legales: filas de la sección "Legal" en la pestaña Cuenta.
const legalTermsRow = $('#legalTermsRow');
if (legalTermsRow) legalTermsRow.onclick = () => openLegalDoc('terms');
const legalPrivacyRow = $('#legalPrivacyRow');
if (legalPrivacyRow) legalPrivacyRow.onclick = () => openLegalDoc('privacy');
const legalModalClose = $('#legalModalClose');
if (legalModalClose) legalModalClose.onclick = closeLegalDoc;
const legalModalX = $('#legalModalX');
if (legalModalX) legalModalX.onclick = closeLegalDoc;
const legalModalEl = $('#legalModal');
if (legalModalEl) legalModalEl.addEventListener('click', (e) => { if (e.target === legalModalEl) closeLegalDoc(); });
const notifPublishBtn = $('#notifPublish');
if (notifPublishBtn) notifPublishBtn.onclick = publishAnnouncement;
$('#brandHome').onclick = () => showView('home');
$('#cartTopBtn').onclick = () => showView('cart');
$('#lbCart').onclick = () => { if (lightboxPhoto) addToCart(lightboxPhoto); };
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

// El botón "Entrar" del encabezado vive en #session (y el avatar con
// las iniciales cuando hay sesión): un solo manejador cubre el botón
// que ya trae el HTML, el que dibuja refreshAuth sin sesión y el que
// dibuja si la sesión no contesta. Antes el botón solo aparecía cuando
// /api/auth-status contestaba, y sin sesión no había con qué entrar
// desde arriba.
$('#session').addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#loginBtn')) showView('account'); });

// La sesión se resuelve primero: el inicio, el regreso de un pago y
// los links profundos usan el carrito, y el carrito activo depende de
// quién tiene la sesión (setActiveCart corre dentro de refreshAuth).
refreshAuth().finally(() => {
  loadHome();
  handlePayReturn();
  handleDeepLinks();
  updateCartBadge();
});
if (resetToken) showView('account');
checkInvite();
// Si la URL trae ?unirme=1 (link para mandar a un fotógrafo), abrir el
// inicio con el formulario "Soy fotógrafo, quiero unirme" ya desplegado.
if (new URLSearchParams(location.search).get('unirme')) goToPhotographerForm();
if (isInAppBrowser()) { const b = $('#inAppBanner'); if (b) b.style.display = ''; }

// ---------- Botón flotante "volver arriba" ----------
// Aparece al bajar más de 300px y al picarlo regresa arriba suave.
// Es global: sirve en el inicio, el panel, la galería y cualquier vista.
function initToTopBtn() {
  const btn = document.getElementById('toTopBtn');
  if (!btn) return;
  const onScroll = () => { btn.classList.toggle('show', window.scrollY > 300); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  btn.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'smooth' }); });
}
initToTopBtn();
