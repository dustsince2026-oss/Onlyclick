'use strict';
// Lógica de la app, independiente del transporte (Vercel o servidor local).
// Cada función recibe { store, body, query, tokenUser } y devuelve { status, data }.
// La búsqueda por dorsal usa los dorsales guardados en cada foto. Esos dorsales
// se leen automáticamente al subir (visión por IA con Gemini cuando hay llave,
// si no OCR local en el teléfono) y se pueden corregir o releer después.
const { getStore } = require('./store');
const { hashPassword, verifyPassword, signToken, verifyToken, publicUser } = require('./auth');

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

async function listEvents(store) {
  return { status: 200, data: { events: await store.listEvents() } };
}

async function createEvent(store, user, body) {
  requirePhotographer(user);
  const name = String(body.name || '').trim();
  if (!name) throw err(400, 'El evento necesita un nombre.');
  const ev = await store.createEvent({
    photographerId: user.id, name, sport: String(body.sport || 'Carrera'),
    eventDate: String(body.eventDate || ''), location: String(body.location || ''),
    freeMode: body.freeMode !== false,
  });
  return { status: 201, data: { event: ev } };
}

async function getEvent(store, user, eventId) {
  const ev = await store.getEvent(eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  const photos = await store.listPhotos(eventId);
  const owned = new Set();
  if (user) for (const d of await store.listDownloadsByUser(user.id)) owned.add(d.photoId);
  return { status: 200, data: { event: ev, photos: photos.map(p => ({ ...p, owned: owned.has(p.id), filePath: undefined, storagePath: undefined })) } };
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
  const photo = await store.createPhoto({ eventId: ev.id, filename: String(body.filename || 'foto.jpg'), mimeType, bibs, price: Number(body.price || 0), fileBuffer });
  return { status: 201, data: { photo: { ...photo, filePath: undefined, storagePath: undefined } } };
}

async function searchBib(store, query) {
  const bib = normBib(query.bib);
  if (!bib) throw err(400, 'Escribe un dorsal.');
  const eventId = query.eventId ? Number(query.eventId) : null;
  const events = eventId ? [await store.getEvent(eventId)].filter(Boolean) : await store.listEvents();
  const out = [];
  for (const ev of events) {
    for (const p of await store.listPhotos(ev.id)) {
      if ((p.bibs || []).map(normBib).includes(bib)) out.push({ ...p, eventName: ev.name, freeMode: ev.freeMode, filePath: undefined, storagePath: undefined });
    }
  }
  return { status: 200, data: { bib, photos: out } };
}

// Registrar descarga gratis (eventos en modo gratis) o compra simulada (eventos de pago).
// NO es un pago real: no hay pasarela. Cuando el fotógrafo active el cobro,
// aquí quedará el punto donde se conecta Stripe / Mercado Pago.
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
    photos.push({ ...p, eventName: ev ? ev.name : '', amount: d.amount, downloadedAt: d.createdAt, filePath: undefined, storagePath: undefined });
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

async function updatePhoto(store, user, body) {
  requirePhotographer(user);
  const p = await store.getPhoto(body.photoId);
  if (!p) throw err(404, 'Foto no encontrada.');
  const ev = await store.getEvent(p.eventId);
  if (!ev || ev.photographerId !== user.id) throw err(403, 'Esa foto no es tuya.');
  const patch = {};
  if (body.bibs !== undefined) patch.bibs = (Array.isArray(body.bibs) ? body.bibs : [body.bibs]).map(normBib).filter(Boolean);
  if (body.price !== undefined) patch.price = Number(body.price || 0);
  return { status: 200, data: { photo: await store.updatePhoto(p.id, patch) } };
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

// Lee el dorsal de una foto con visión por IA (Gemini, capa gratuita).
// Recibe { photoId } (foto ya subida) o { dataBase64, mimeType } (al subir).
// Sin GEMINI_API_KEY devuelve { ok:false, reason:'no-key' } para que el
// cliente use el OCR local. Siempre responde 200 salvo errores de permiso.
async function readBib(store, user, body) {
  requirePhotographer(user);
  const key = (process.env.GEMINI_API_KEY || '').trim();
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
  const prompt = 'En esta foto de una carrera, lee el número de dorsal que lleva el corredor en el pecho. Responde solo con este JSON: {"bib": "90"} con el número tal como se ve, sin espacios. Si no se ve ningún dorsal claro, responde {"bib": null}. Si se ven varios dorsales, responde el más grande y claro.';
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: buf.toString('base64') } }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
  });
  if (!res.ok) return { status: 200, data: { ok: false, reason: 'ia-error' } };
  const json = await res.json();
  const text = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text) || '';
  let bib = null;
  try { const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()); if (parsed && parsed.bib != null) bib = String(parsed.bib).replace(/\D/g, ''); } catch (_) { const m = text.match(/\d{1,4}/); if (m) bib = m[0]; }
  return { status: 200, data: { ok: true, bib: bib || null, source: 'ia' } };
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
  const bytes = await store.readPhotoBytes(photo);
  return { status: 200, file: { bytes, mimeType: photo.mimeType, filename: `onlyclick-foto-${photo.id}.${(photo.filename || 'foto.jpg').split('.').pop() || 'jpg'}`, inline: req && req.query && req.query.inline === '1' } };
}

async function dispatch(route, req) {
  const store = getStore();
  const user = await currentUser(store, req.token);
  const b = req.body || {};
  switch (route) {
    case 'register': return register(store, b);
    case 'login': return login(store, b);
    case 'auth-status': return authStatus(store, req.token);
    case 'list-events': return listEvents(store);
    case 'create-event': return createEvent(store, user, b);
    case 'get-event': return getEvent(store, user, req.query.eventId);
    case 'upload-photo': return uploadPhoto(store, user, b);
    case 'search': return searchBib(store, req.query);
    case 'claim': return claimPhotos(store, user, b, false);
    case 'purchase': return claimPhotos(store, user, b, true);
    case 'my-photos': return listPurchases(store, user);
    case 'sales': return listSales(store, user);
    case 'set-free-mode': return setFreeMode(store, user, b);
    case 'update-photo': return updatePhoto(store, user, b);
    case 'delete-photo': return deletePhoto(store, user, req.query.photoId || b.photoId);
    case 'read-bib': return readBib(store, user, b);
    case 'photo-file': return photoFile(store, user, req.query.id, req);
    default: throw err(404, 'Ruta no encontrada: ' + route);
  }
}

module.exports = { dispatch, err };
