'use strict';
// Lógica de la app, independiente del transporte (Vercel o servidor local).
// Cada función recibe { store, body, query, tokenUser } y devuelve { status, data }.
// La búsqueda por dorsal usa los dorsales guardados en cada foto. Esos dorsales
// se leen automáticamente al subir (visión por IA con Gemini cuando hay llave,
// si no OCR local en el teléfono) y se pueden corregir o releer después.
const crypto = require('crypto');
const { getStore } = require('./store');
const { hashPassword, verifyPassword, signToken, verifyToken, signResetToken, verifyResetToken, publicUser } = require('./auth');
const { sendResetEmail } = require('./mailer');
const { createCheckoutLink, getCheckout } = require('./clip');

function err(status, message) { const e = new Error(message); e.status = status; return e; }
function normBib(b) { return String(b == null ? '' : b).trim(); }

async function currentUser(store, token) {
  const id = verifyToken(token);
  if (!id) return null;
  return store.findUserById(id);
}
function requireUser(u) { if (!u) throw err(401, 'Inicia sesión para continuar.'); return u; }
function requirePhotographer(u) { requireUser(u); if (u.role !== 'photographer') throw err(403, 'Solo la cuenta de fotógrafo puede hacer eso.'); return u; }

async function register(store, body) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = body.role === 'photographer' ? 'photographer' : 'athlete';
  if (!name || !email.includes('@') || password.length < 6) throw err(400, 'Faltan datos: nombre, correo válido y contraseña de al menos 6 caracteres.');
  if (role === 'photographer' && await store.photographerExists()) throw err(403, 'Ya existe una cuenta de fotógrafo. Solo puede haber una; las demás cuentas son de deportista.');
  if (await store.findUserByEmail(email)) throw err(400, 'Ese correo ya tiene cuenta. Inicia sesión.');
  const user = await store.createUser({ name, email, passwordHash: hashPassword(password), role });
  return { status: 201, data: { user: publicUser(user), token: signToken(user.id) } };
}

async function login(store, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const user = await store.findUserByEmail(email);
  if (!user || !verifyPassword(String(body.password || ''), user.passwordHash)) throw err(401, 'Correo o contraseña incorrectos.');
  return { status: 200, data: { user: publicUser(user), token: signToken(user.id) } };
}

async function authStatus(store, token) {
  return { status: 200, data: { photographerTaken: await store.photographerExists(), user: publicUser(await currentUser(store, token)) } };
}

// Pide restablecer la contraseña: manda un enlace al correo (vale 1 hora).
// Siempre responde igual, exista o no el correo, para no revelar cuentas.
async function requestPasswordReset(store, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const user = email.includes('@') ? await store.findUserByEmail(email) : null;
  if (user) {
    const token = signResetToken(user.id);
    const base = (process.env.PUBLIC_URL || 'https://onlyclick-zeta.vercel.app').replace(/\/$/, '');
    await sendResetEmail(user.email, user.name, `${base}/?reset=${token}`);
  }
  return { status: 200, data: { ok: true } };
}

async function resetPassword(store, body) {
  const userId = verifyResetToken(String(body.token || ''));
  if (!userId) throw err(400, 'El enlace no es válido o ya venció. Pide uno nuevo.');
  const password = String(body.password || '');
  if (password.length < 6) throw err(400, 'La contraseña debe tener al menos 6 caracteres.');
  const user = await store.findUserById(userId);
  if (!user) throw err(404, 'Cuenta no encontrada.');
  await store.updateUserPassword(user.id, hashPassword(password));
  return { status: 200, data: { ok: true } };
}

async function listEvents(store) {
  return { status: 200, data: { events: await store.listEvents() } };
}

async function createEvent(store, user, body) {
  requirePhotographer(user);
  const name = String(body.name || '').trim();
  if (!name) throw err(400, 'El evento necesita un nombre.');
  const pm = Number(body.priceMxn);
  const ev = await store.createEvent({
    photographerId: user.id, name, sport: String(body.sport || 'Carrera'),
    eventDate: String(body.eventDate || ''), location: String(body.location || ''),
    freeMode: body.freeMode !== false,
    priceMxn: (Number.isFinite(pm) && pm >= 1 && pm <= 5000) ? pm : 20,
  });
  return { status: 201, data: { event: ev } };
}

async function getEvent(store, user, eventId) {
  const ev = await store.getEvent(eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  const photos = await store.listPhotos(eventId);
  const owned = new Set();
  if (user) for (const d of await store.listDownloadsByUser(user.id)) owned.add(d.photoId);
  const photographer = await store.findUserById(ev.photographerId);
  return { status: 200, data: { event: ev, photos: photos.map(p => ({ ...p, owned: owned.has(p.id), filePath: undefined, storagePath: undefined, thumbPath: undefined })), tipClabe: photographer ? (photographer.tipClabe || '') : '', tipName: photographer ? (photographer.name || '') : '' } };
}

async function uploadPhoto(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(body.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.photographerId !== user.id) throw err(403, 'Ese evento no es tuyo.');
  const dataBase64 = String(body.dataBase64 || '');
  if (!dataBase64) throw err(400, 'No llegó ninguna foto.');
  const fileBuffer = Buffer.from(dataBase64, 'base64');
  if (fileBuffer.length === 0 || fileBuffer.length > 10 * 1024 * 1024) throw err(400, 'La foto está vacía o pesa más de 10 MB.');
  const mimeType = String(body.mimeType || 'image/jpeg');
  if (!mimeType.startsWith('image/')) throw err(400, 'El archivo no es una imagen.');
  const bibs = Array.isArray(body.bibs) ? body.bibs.map(normBib).filter(Boolean) : (body.bibs ? [normBib(body.bibs)] : []);
  // Miniatura opcional (la genera el cliente en 400px): si viene inválida
  // o muy grande se ignora sin romper la subida.
  let thumbBuffer = null;
  const thumbBase64 = String(body.thumbBase64 || '');
  if (thumbBase64) {
    const buf = Buffer.from(thumbBase64, 'base64');
    if (buf.length > 0 && buf.length <= 1024 * 1024) thumbBuffer = buf;
  }
  const photo = await store.createPhoto({ eventId: ev.id, filename: String(body.filename || 'foto.jpg'), mimeType, bibs, price: Number(body.price || 0), fileBuffer, thumbBuffer });
  return { status: 201, data: { photo: { ...photo, filePath: undefined, storagePath: undefined, thumbPath: undefined } } };
}

async function searchBib(store, query) {
  const bib = normBib(query.bib);
  if (!bib) throw err(400, 'Escribe un dorsal.');
  const eventId = query.eventId ? Number(query.eventId) : null;
  const events = eventId ? [await store.getEvent(eventId)].filter(Boolean) : await store.listEvents();
  const out = [];
  for (const ev of events) {
    for (const p of await store.listPhotos(ev.id)) {
      if ((p.bibs || []).map(normBib).includes(bib)) out.push({ ...p, eventName: ev.name, freeMode: ev.freeMode, priceMxn: ev.priceMxn, filePath: undefined, storagePath: undefined, thumbPath: undefined });
    }
  }
  return { status: 200, data: { bib, photos: out } };
}

// Registrar descarga gratis (eventos en modo gratis). El cobro real de
// eventos de pago es con Clip (POST /api/checkout-create); la ruta
// simulada /api/purchase se desactivó para que nadie descargue sin pagar.
async function claimPhotos(store, user, body, paid) {
  requireUser(user);
  const ids = (Array.isArray(body.photoIds) ? body.photoIds : [body.photoId]).map(Number).filter(Boolean);
  if (!ids.length) throw err(400, 'No hay fotos seleccionadas.');
  const claimed = [];
  for (const id of ids) {
    const photo = await store.getPhoto(id);
    if (!photo) continue;
    const ev = await store.getEvent(photo.eventId);
    if (!ev) continue;
    if (paid && ev.freeMode) throw err(400, 'Ese evento es gratis, no se cobra.');
    if (!paid && !ev.freeMode) throw err(400, 'Ese evento es de pago.');
    if (await store.hasDownload(user.id, id)) { claimed.push(id); continue; }
    await store.addDownload({ userId: user.id, photoId: id, eventId: ev.id, amount: paid ? Number(photo.price || 0) : 0 });
    claimed.push(id);
  }
  return { status: 200, data: { claimed, count: claimed.length } };
}

async function listPurchases(store, user) {
  requireUser(user);
  const downloads = await store.listDownloadsByUser(user.id);
  const photos = [];
  for (const d of downloads) {
    const p = await store.getPhoto(d.photoId); if (!p) continue;
    const ev = await store.getEvent(d.eventId);
    photos.push({ ...p, eventName: ev ? ev.name : '', amount: d.amount, downloadedAt: d.createdAt, filePath: undefined, storagePath: undefined, thumbPath: undefined });
  }
  return { status: 200, data: { photos } };
}

async function listSales(store, user) {
  requirePhotographer(user);
  const downloads = await store.listAllDownloads();
  const rows = [];
  let revenue = 0, freeCount = 0;
  for (const d of downloads) {
    const p = await store.getPhoto(d.photoId); const ev = await store.getEvent(d.eventId);
    const buyer = await store.findUserById(d.userId);
    revenue += Number(d.amount || 0); if (!d.amount) freeCount += 1;
    rows.push({ id: d.id, photoId: d.photoId, eventName: ev ? ev.name : '', bibs: p ? p.bibs : [], buyerName: buyer ? buyer.name : '', amount: d.amount, createdAt: d.createdAt });
  }
  return { status: 200, data: { sales: rows, totalDownloads: rows.length, freeDownloads: freeCount, revenue } };
}

async function setFreeMode(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(body.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.photographerId !== user.id) throw err(403, 'Ese evento no es tuyo.');
  const updated = await store.updateEvent(ev.id, { freeMode: body.freeMode !== false });
  return { status: 200, data: { event: updated } };
}

async function setTip(store, user, body) {
  requirePhotographer(user);
  const clabe = String(body.clabe || '').replace(/[\s-]/g, '');
  if (clabe && !/^\d{18}$/.test(clabe)) throw err(400, 'La CLABE debe tener 18 dígitos.');
  const updated = await store.setTipClabe(user.id, clabe);
  return { status: 200, data: { tipClabe: updated ? (updated.tipClabe || '') : clabe } };
}

async function updatePhoto(store, user, body) {
  requirePhotographer(user);
  const p = await store.getPhoto(body.photoId);
  if (!p) throw err(404, 'Foto no encontrada.');
  const ev = await store.getEvent(p.eventId);
  if (!ev || ev.photographerId !== user.id) throw err(403, 'Esa foto no es tuya.');
  const patch = {};
  if (body.bibs !== undefined) patch.bibs = (Array.isArray(body.bibs) ? body.bibs : [body.bibs]).map(normBib).filter(Boolean);
  if (body.price !== undefined) patch.price = Number(body.price || 0);
  const updated = await store.updatePhoto(p.id, patch);
  return { status: 200, data: { photo: { ...updated, filePath: undefined, storagePath: undefined, thumbPath: undefined } } };
}

async function deletePhoto(store, user, photoId) {
  requirePhotographer(user);
  const p = await store.getPhoto(photoId);
  if (!p) throw err(404, 'Foto no encontrada.');
  const ev = await store.getEvent(p.eventId);
  if (!ev || ev.photographerId !== user.id) throw err(403, 'Esa foto no es tuya.');
  await store.deletePhoto(p.id);
  return { status: 200, data: { ok: true } };
}

// Sube una foto aparte como portada del evento (no es una foto del evento:
// no aparece en la galería ni en la búsqueda por dorsal). Si ya había
// portada, la reemplaza y borra el archivo anterior.
async function uploadCover(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(body.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.photographerId !== user.id) throw err(403, 'Ese evento no es tuyo.');
  const dataBase64 = String(body.dataBase64 || '');
  if (!dataBase64) throw err(400, 'No llegó ninguna foto.');
  const fileBuffer = Buffer.from(dataBase64, 'base64');
  if (fileBuffer.length === 0 || fileBuffer.length > 10 * 1024 * 1024) throw err(400, 'La foto está vacía o pesa más de 10 MB.');
  const mimeType = String(body.mimeType || 'image/jpeg');
  if (!mimeType.startsWith('image/')) throw err(400, 'El archivo no es una imagen.');
  await store.setEventCover(ev.id, { fileBuffer, mimeType });
  return { status: 200, data: { ok: true } };
}

// Devuelve los bytes de la portada de un evento (visible para todos).
async function coverFile(store, user, eventId) {
  const cover = await store.getEventCover(eventId);
  if (!cover) throw err(404, 'Este evento no tiene portada.');
  return { status: 200, file: { bytes: cover.bytes, mimeType: cover.mimeType, filename: `onlyclick-portada-${eventId}.jpg`, inline: true } };
}

// Borra un evento completo: sus fotos del bucket (libera espacio),
// sus filas de fotos y descargas (cascada en la base) y el evento.
// Solo el fotógrafo dueño del evento. No se puede deshacer.
async function deleteEvent(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(body.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.photographerId !== user.id) throw err(403, 'Ese evento no es tuyo.');
  const result = await store.deleteEvent(ev.id);
  return { status: 200, data: { ok: true, photos: result ? (result.photos || 0) : 0 } };
}

// Lee el dorsal de una foto con visión por IA (Gemini, capa gratuita).
// Recibe { photoId } (foto ya subida) o { dataBase64, mimeType } (al subir).
// Sin GEMINI_API_KEY devuelve { ok:false, reason:'no-key' } para que el
// cliente use el OCR local. Siempre responde 200 salvo errores de permiso.
async function readBib(store, user, body) {
  requirePhotographer(user);
  // La llave se pega desde el teléfono y puede traer caracteres invisibles
  // (lo mismo que pasó con la llave de Supabase): se limpia igual.
  const key = (process.env.GEMINI_API_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();
  if (!key) return { status: 200, data: { ok: false, reason: 'no-key' } };
  let buf, mime = 'image/jpeg';
  if (body.photoId) {
    const p = await store.getPhoto(body.photoId);
    if (!p) throw err(404, 'Foto no encontrada.');
    const ev = await store.getEvent(p.eventId);
    if (!ev || ev.photographerId !== user.id) throw err(403, 'Esa foto no es tuya.');
    buf = await store.readPhotoBytes(p); mime = p.mimeType || mime;
  } else if (body.dataBase64) {
    buf = Buffer.from(String(body.dataBase64), 'base64');
    mime = String(body.mimeType || 'image/jpeg');
  } else throw err(400, 'Falta la foto.');
  if (!buf || !buf.length || buf.length > 10 * 1024 * 1024) throw err(400, 'La foto está vacía o pesa más de 10 MB.');
  const prompt = 'En esta foto de una carrera, lee TODOS los números de dorsal que llevan los corredores en el pecho (puede haber varios corredores). Ignora por completo los números de los anuncios, pancartas, logos y fondo: solo cuentan los dorsales que lleva la gente puesta. Responde solo con este JSON: {"bibs": ["90", "301"]} con los números tal como se ven, sin espacios. Si no se ve ningún dorsal claro, responde {"bibs": []}.';
  // gemini-2.0-flash fue apagado por Google el 1 jun 2026; el reemplazo
  // oficial es gemini-3.8-flash (gratis en el plan free). Pero el 3.8 es el
  // modelo nuevo y más saturado: a veces responde 503 por alta demanda.
  // Se prueban en orden y se usa el primero que responda.
  const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
  let lastErr = null;
  for (const model of MODELS) {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: buf.toString('base64') } }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
    });
    if (res.ok) {
      const json = await res.json();
      const text = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text) || '';
      let bibs = [];
      try {
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        const raw = parsed && (Array.isArray(parsed.bibs) ? parsed.bibs : (parsed.bib != null ? [parsed.bib] : []));
        bibs = [...new Set((raw || []).map(v => String(v).replace(/\D/g, '')).filter(v => v.length >= 1 && v.length <= 4))];
      } catch (_) { const m = text.match(/\d{1,4}/); if (m) bibs = [m[0]]; }
      return { status: 200, data: { ok: true, bibs, bib: bibs[0] || null, source: 'ia' } };
    }
    let detail = '';
    try { const ej = await res.json(); detail = String((ej.error && ej.error.message) || '').slice(0, 120); } catch (_) {}
    lastErr = { status: res.status, detail };
    // Solo se reintenta con otro modelo si es saturación (503) o límite (429).
    if (res.status !== 503 && res.status !== 429) break;
  }
  return { status: 200, data: { ok: false, reason: 'ia-error', status: lastErr.status, detail: lastErr.detail } };
}

// Devuelve los bytes de la foto para la descarga real.
// Ruta de mismo origen: /api/photo?id=123 — en Chrome Android esto dispara
// el gestor de descargas con Content-Disposition: attachment.
// NO es un blob URL ni navigator.share: es una URL de archivo de mismo origen.
async function photoFile(store, user, photoId, req) {
  const photo = await store.getPhoto(photoId);
  if (!photo) throw err(404, 'Foto no encontrada.');
  const ev = await store.getEvent(photo.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  const inline = req && req.query && req.query.inline === '1';
  if (!ev.freeMode && !inline) {
    // Evento de pago: la vista previa (inline) se permite para ver la foto,
    // pero la descarga del archivo original exige haberla comprado.
    // Nota: esta versión no añade marca de agua a la vista previa; si el
    // fotógrafo vende fotos, conviene añadirla antes de cobrar de verdad.
    if (!user) throw err(401, 'Inicia sesión para descargar esta foto.');
    if (user.role !== 'photographer' && !(await store.hasDownload(user.id, photo.id))) throw err(403, 'Esta foto es de pago. Cómprala primero.');
  }
  // Miniatura para la galería (?thumb=1): si la foto tiene miniatura se
  // sirve esa (~30-50 KB en vez de ~300 KB); si no tiene (fotos subidas
  // antes de las miniaturas) se cae a la foto completa sin error.
  let bytes = null;
  let mimeType = photo.mimeType;
  if (req && req.query && req.query.thumb === '1') {
    bytes = await store.readThumbBytes(photo);
    if (bytes) mimeType = 'image/jpeg';
  }
  // Vista previa con marca de agua (evento de pago, sin compra): la vista
  // previa (inline) de quien no ha comprado sirve la miniatura de 400px
  // en vez del original, y el frontend le pone encima el texto
  // "ONLYCLICK • VISTA PREVIA". Si no hay miniatura (fotos viejas), cae
  // al original, pero el texto del frontend sigue visible. El original
  // solo se descarga con compra (o siendo el fotógrafo).
  if (!bytes && inline && !ev.freeMode && !(user && (user.role === 'photographer' || await store.hasDownload(user.id, photo.id)))) {
    bytes = await store.readThumbBytes(photo);
    if (bytes) mimeType = 'image/jpeg';
  }
  if (!bytes) bytes = await store.readPhotoBytes(photo);
  return { status: 200, file: { bytes, mimeType, filename: `onlyclick-foto-${photo.id}.${(photo.filename || 'foto.jpg').split('.').pop() || 'jpg'}`, inline: req && req.query && req.query.inline === '1' } };
}


// ================= Cobro con Clip (Checkout Redireccionado v2) =================
// Docs oficiales: https://developer.clip.mx — referencia ?page=cnp-mxn (crear),
// ?page=cnp-st (consultar), ?page=cnp-lwh (webhooks), ?page=i-auth (Basic Auth).
// Base: https://api.payclip.com. Auth: Authorization: Basic base64(API_KEY:SECRET).
// Las llaves test_ NO sirven para links de Checkout Redireccionado: la
// prueba de punta a punta es en producción con un cobro real.
function publicBase() {
  return (process.env.PUBLIC_URL || 'https://onlyclick-zeta.vercel.app').replace(/\/$/, '');
}

// Precio por foto de un evento: lo fija el fotógrafo (default $20 MXN).
// Nunca se cobra menos de $1 (mínimo de Clip) ni más de $5,000 (límite
// predeterminado por transacción de Clip).
function eventPrice(ev) {
  const p = Number(ev.priceMxn || 0);
  if (Number.isFinite(p) && p >= 1 && p <= 5000) return Math.round(p * 100) / 100;
  return 20;
}

// Referencia externa de Clip (metadata.external_reference): máx 36
// caracteres. Sirve para atar el regreso desde Clip con nuestro pago.
function makeExternalRef(photoId, userId) {
  return ('OC-' + photoId + '-' + userId + '-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex')).slice(0, 36);
}

// URL del webhook: el secreto es nuestro (CLIP_WEBHOOK_SECRET, inventado
// por el fotógrafo como AUTH_SECRET). Clip NO firma sus notificaciones,
// así que el secreto viaja en la URL y solo sirve para descartar avisos
// falsos baratos: la seguridad real es que el webhook NUNCA desbloquea
// nada por sí solo — siempre se vuelve a consultar el estado en Clip.
function webhookUrl() {
  const secret = (process.env.CLIP_WEBHOOK_SECRET || '').replace(/[^\x20-\x7E]/g, '').trim();
  return publicBase() + '/api/clip-webhook' + (secret ? '?s=' + encodeURIComponent(secret) : '');
}

function clipStatusToPayment(status) {
  switch (status) {
    case 'CHECKOUT_COMPLETED': return 'completed';
    case 'CHECKOUT_CANCELLED': return 'cancelled';
    case 'CHECKOUT_EXPIRED': return 'expired';
    default: return 'pending';
  }
}

// Marca el pago como completado y registra la descarga (idempotente: si
// ya estaba pagado o ya tenía la descarga, no duplica nada).
async function markPaymentPaid(store, payment, clipData) {
  const already = await store.hasDownload(payment.userId, payment.photoId);
  if (payment.status !== 'completed') {
    await store.updatePaymentStatus(payment.id, { status: 'completed', receiptNo: (clipData && clipData.receipt_no) || payment.receiptNo || '' });
  }
  if (!already) {
    await store.addDownload({ userId: payment.userId, photoId: payment.photoId, eventId: payment.eventId, amount: payment.amount });
  }
  return { already };
}

// Vuelve a consultar el estado real en Clip y actualiza nuestro pago.
// Es el único lugar donde se decide si algo está pagado: ni el webhook
// ni la redirección del navegador son prueba de pago por sí solos.
async function refreshPaymentFromClip(store, payment) {
  const cur = await getCheckout(payment.clipPaymentRequestId);
  if (clipStatusToPayment(cur.status) === 'completed') {
    await markPaymentPaid(store, payment, cur);
    return { clip: cur, payment: await store.getPaymentById(payment.id), paid: true };
  }
  await store.updatePaymentStatus(payment.id, { status: clipStatusToPayment(cur.status) });
  return { clip: cur, payment: await store.getPaymentById(payment.id), paid: false };
}

// POST /api/checkout-create { photoId } — crea el link de pago de Clip
// para una foto de un evento DE PAGO y devuelve la URL del checkout.
async function createCheckout(store, user, body) {
  requireUser(user);
  const photoId = Number(body.photoId);
  if (!photoId) throw err(400, 'Falta la foto.');
  const photo = await store.getPhoto(photoId);
  if (!photo) throw err(404, 'Foto no encontrada.');
  const ev = await store.getEvent(photo.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.freeMode) throw err(400, 'Ese evento es gratis, no se cobra.');
  if (user.role === 'photographer') throw err(400, 'Eres el fotógrafo de este evento.');
  if (await store.hasDownload(user.id, photo.id)) return { status: 200, data: { paid: true, photoId: photo.id } };
  const price = eventPrice(ev);
  // Reutilizar un link pendiente vigente para no crear links de más.
  const pending = await store.getLatestPaymentByUserPhoto(user.id, photo.id);
  if (pending && pending.status === 'pending' && pending.clipPaymentRequestId) {
    try {
      const cur = await getCheckout(pending.clipPaymentRequestId);
      if (cur && (cur.status === 'CHECKOUT_CREATED' || cur.status === 'CHECKOUT_PENDING')) {
        return { status: 200, data: { checkoutUrl: cur.payment_request_url, paymentRequestId: cur.payment_request_id, amount: pending.amount } };
      }
      await store.updatePaymentStatus(pending.id, { status: clipStatusToPayment(cur.status) });
    } catch (_) { /* si Clip falla al consultar, se crea un link nuevo */ }
  }
  const ref = makeExternalRef(photo.id, user.id);
  const base = publicBase();
  const created = await createCheckoutLink({
    amount: price,
    currency: 'MXN',
    purchase_description: ('Foto OnlyClick — ' + ev.name + ' — dorsal ' + ((photo.bibs || []).join(', ') || 'sin dorsal')).slice(0, 255),
    redirection_url: {
      success: base + '/api/checkout-return?ref=' + encodeURIComponent(ref) + '&photoId=' + photo.id,
      error: base + '/api/checkout-return?ref=' + encodeURIComponent(ref) + '&photoId=' + photo.id + '&result=error',
      default: base + '/',
    },
    metadata: { external_reference: ref, customer_info: { name: user.name, email: user.email } },
    webhook_url: webhookUrl(),
    override_settings: { locale: 'es-MX', tip_enabled: false },
  });
  const payment = await store.createPayment({
    clipPaymentRequestId: created.payment_request_id,
    externalReference: ref,
    userId: user.id, photoId: photo.id, eventId: ev.id,
    amount: price, currency: 'MXN', status: 'pending',
  });
  return { status: 200, data: { checkoutUrl: created.payment_request_url, paymentRequestId: created.payment_request_id, paymentId: payment.id, amount: price } };
}

// GET /api/checkout-return?ref=...&photoId=... — Clip redirige aquí
// después del pago. Verifica con Clip y redirige (302) al corredor.
// NO requiere sesión: la verificación es contra Clip, no contra el token.
async function checkoutReturn(store, query) {
  const ref = String(query.ref || '');
  const pid = String(query.pid || '');
  const photoId = Number(query.photoId || 0);
  const base = publicBase();
  let payment = null;
  if (ref) payment = await store.getPaymentByExternalRef(ref);
  if (!payment && pid) payment = await store.getPaymentByClipId(pid);
  if (!payment) return { status: 302, redirect: base + '/?pay=error', data: {} };
  const back = base + '/?event=' + payment.eventId + (photoId ? '&photo=' + photoId : '');
  try {
    const r = await refreshPaymentFromClip(store, payment);
    if (r.paid) return { status: 302, redirect: back + '&paid=1', data: {} };
    if (r.payment.status === 'cancelled' || r.payment.status === 'expired') return { status: 302, redirect: back + '&pay=failed', data: {} };
    // Pago en proceso (ej. efectivo en OXXO: el cliente paga después).
    return { status: 302, redirect: back + '&pay=pending', data: {} };
  } catch (_) {
    // Clip no respondió: no bloquear al corredor; la app re-consulta sola.
    return { status: 302, redirect: back + '&pay=pending', data: {} };
  }
}

// POST /api/checkout-status { paymentRequestId } o { photoId } — para
// que el frontend pregunte si un pago pendiente ya se confirmó.
async function checkoutStatus(store, user, body) {
  requireUser(user);
  let payment = null;
  if (body.paymentRequestId) payment = await store.getPaymentByClipId(String(body.paymentRequestId));
  else if (body.photoId) payment = await store.getLatestPaymentByUserPhoto(user.id, Number(body.photoId));
  if (!payment) return { status: 200, data: { paid: false, status: 'none' } };
  if (payment.userId !== user.id && user.role !== 'photographer') throw err(403, 'Ese pago no es tuyo.');
  if (payment.status === 'completed') return { status: 200, data: { paid: true, status: 'completed', receiptNo: payment.receiptNo || '' } };
  if (payment.status === 'cancelled' || payment.status === 'expired') return { status: 200, data: { paid: false, status: payment.status } };
  try {
    const r = await refreshPaymentFromClip(store, payment);
    return { status: 200, data: { paid: r.paid, status: r.payment.status, receiptNo: r.payment.receiptNo || '' } };
  } catch (_) {
    return { status: 200, data: { paid: false, status: payment.status, clipError: true } };
  }
}

// POST /api/clip-webhook?s=<secreto> — aviso de Clip cuando cambia un
// pago. El payload v2 es mínimo: { id, resource, resource_status }.
// NO trae monto ni estado confiable: solo sirve de pista para volver a
// consultar GET /v2/checkout/{id}. Responde 200 rápido (Clip reintenta
// si no recibe 2xx). La doc de Clip menciona validar que origin sea
// "checkout-api", pero su tabla de payload no incluye ese campo: si viene
// y no es ese valor se ignora; si no viene, igual se procesa porque la
// verificación real es el GET a Clip.
async function clipWebhook(store, body, query) {
  const secret = (process.env.CLIP_WEBHOOK_SECRET || '').replace(/[^\x20-\x7E]/g, '').trim();
  if (secret) {
    const got = String((query && query.s) || '');
    if (!got || got !== secret) return { status: 200, data: { ok: false, reason: 'bad-secret' } };
  }
  const id = String((body && body.id) || '');
  const resource = String((body && body.resource) || '');
  if (!id) return { status: 200, data: { ok: false, reason: 'no-id' } };
  if (body.origin && body.origin !== 'checkout-api') return { status: 200, data: { ok: true, ignored: 'origin' } };
  if (resource && resource !== 'CHECKOUT') return { status: 200, data: { ok: true, ignored: resource } };
  const payment = await store.getPaymentByClipId(id);
  if (!payment) return { status: 200, data: { ok: true, ignored: 'unknown-payment' } };
  if (payment.status === 'completed') return { status: 200, data: { ok: true, already: true } };
  try {
    const r = await refreshPaymentFromClip(store, payment);
    return { status: 200, data: { ok: true, paid: r.paid, status: r.payment.status } };
  } catch (_) {
    return { status: 200, data: { ok: false, reason: 'clip-error' } };
  }
}

// POST /api/set-event-price { eventId, priceMxn } — el fotógrafo fija
// el precio por foto de su evento (solo importa en eventos de pago).
async function setEventPrice(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(body.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.photographerId !== user.id) throw err(403, 'Ese evento no es tuyo.');
  const price = Number(body.priceMxn);
  if (!Number.isFinite(price) || price < 1 || price > 5000) throw err(400, 'El precio por foto debe ser entre $1 y $5,000 MXN.');
  const updated = await store.updateEvent(ev.id, { priceMxn: Math.round(price * 100) / 100 });
  return { status: 200, data: { event: updated } };
}

async function dispatch(route, req) {
  const store = getStore();
  const user = await currentUser(store, req.token);
  const b = req.body || {};
  switch (route) {
    case 'register': return register(store, b);
    case 'login': return login(store, b);
    case 'password-forgot': return requestPasswordReset(store, b);
    case 'password-reset': return resetPassword(store, b);
    case 'auth-status': return authStatus(store, req.token);
    case 'list-events': return listEvents(store);
    case 'create-event': return createEvent(store, user, b);
    case 'get-event': return getEvent(store, user, req.query.eventId);
    case 'upload-photo': return uploadPhoto(store, user, b);
    case 'search': return searchBib(store, req.query);
    case 'claim': return claimPhotos(store, user, b, false);
    // Compra simulada DESACTIVADA: con Clip real, /api/purchase dejaba
    // descargar sin pagar. El cobro es POST /api/checkout-create.
    case 'purchase': throw err(410, 'El pago ahora es con Clip. Usa el botón "Pagar y descargar".');
    case 'my-photos': return listPurchases(store, user);
    case 'sales': return listSales(store, user);
    case 'set-free-mode': return setFreeMode(store, user, b);
    case 'set-tip': return setTip(store, user, b);
    case 'update-photo': return updatePhoto(store, user, b);
    case 'delete-photo': return deletePhoto(store, user, req.query.photoId || b.photoId);
    case 'delete-event': return deleteEvent(store, user, b);
    case 'upload-cover': return uploadCover(store, user, b);
    case 'cover-file': return coverFile(store, user, req.query.eventId);
    case 'read-bib': return readBib(store, user, b);
    case 'checkout-create': return createCheckout(store, user, b);
    case 'checkout-return': return checkoutReturn(store, req.query);
    case 'checkout-status': return checkoutStatus(store, user, b);
    case 'clip-webhook': return clipWebhook(store, b, req.query);
    case 'set-event-price': return setEventPrice(store, user, b);
    case 'photo-file': return photoFile(store, user, req.query.id, req);
    default: throw err(404, 'Ruta no encontrada: ' + route);
  }
}

module.exports = { dispatch, err };
