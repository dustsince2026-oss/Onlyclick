'use strict';
// Capa de datos con dos adaptadores y la misma interfaz:
//
// 1) Archivo local (por defecto, sin variables de entorno):
//    guarda en data/db.json y data/uploads/. Sirve para probar en local.
//    EN VERCEL NO SIRVE COMO DATO COMPARTIDO: el sistema de archivos de
//    las funciones serverless es efímero y no se comparte entre usuarios.
//    Es solo para desarrollo local.
//
// 2) Supabase (producción en Vercel): pon SUPABASE_URL y
//    SUPABASE_SERVICE_ROLE_KEY en las variables de entorno de Vercel y
//    crea las tablas con supabase/schema.sql. Ahí sí los datos se comparten
//    entre todos los usuarios y persisten. Las fotos van al bucket "photos".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// ---------------- Adaptador de archivo local ----------------
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {
    return { users: [], events: [], photos: [], downloads: [], payments: [], views: [], payouts: [], announcements: [], seq: { user: 1, event: 1, photo: 1, download: 1, payment: 1, view: 1, payout: 1, announcement: 1 } };
  }
}
function saveDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function nextId(db, kind) { const id = db.seq[kind]; db.seq[kind] += 1; return id; }

const fileStore = {
  kind: 'file',
  async photographerExists() { return loadDb().users.some(u => u.role === 'photographer'); },
  async createUser(u) { const db = loadDb(); const row = { id: nextId(db, 'user'), createdAt: new Date().toISOString(), ...u }; db.users.push(row); saveDb(db); return row; },
  async findUserByEmail(email) { return loadDb().users.find(u => u.email.toLowerCase() === String(email).toLowerCase()) || null; },
  async findUserById(id) { return loadDb().users.find(u => u.id === Number(id)) || null; },
  async updateUserPassword(id, passwordHash) { const db = loadDb(); const u = db.users.find(x => x.id === Number(id)); if (!u) return null; u.passwordHash = passwordHash; saveDb(db); return u; },
  async setTipClabe(userId, clabe) { const db = loadDb(); const u = db.users.find(x => x.id === Number(userId)); if (!u) return null; u.tipClabe = clabe; saveDb(db); return u; },
  async setPayoutClabe(userId, clabe) { const db = loadDb(); const u = db.users.find(x => x.id === Number(userId)); if (!u) return null; u.payoutClabe = clabe; saveDb(db); return u; },
  // Todos los fotógrafos (dueño incluido) con sus datos de aprobación.
  async listPhotographers() { return loadDb().users.filter(u => u.role === 'photographer').sort((a, b) => a.id - b.id); },
  async updateUser(id, patch) { const db = loadDb(); const u = db.users.find(x => x.id === Number(id)); if (!u) return null; Object.assign(u, patch); saveDb(db); return u; },
  // ---- Eventos compartidos ----
  // Un fotógrafo entra a un evento creado por otro (o por el dueño) y
  // vende SUS fotos ahí a SU precio. Re-unirse solo actualiza el precio.
  async joinEvent(eventId, photographerId, priceMxn) {
    const db = loadDb();
    if (!db.eventPhotographers) db.eventPhotographers = [];
    const row = db.eventPhotographers.find(x => x.eventId === Number(eventId) && x.photographerId === Number(photographerId));
    if (row) { row.priceMxn = priceMxn; saveDb(db); return row; }
    const r = { eventId: Number(eventId), photographerId: Number(photographerId), priceMxn, joinedAt: new Date().toISOString() };
    db.eventPhotographers.push(r); saveDb(db); return r;
  },
  async leaveEvent(eventId, photographerId) {
    const db = loadDb();
    const before = (db.eventPhotographers || []).length;
    db.eventPhotographers = (db.eventPhotographers || []).filter(x => !(x.eventId === Number(eventId) && x.photographerId === Number(photographerId)));
    saveDb(db); return before - db.eventPhotographers.length;
  },
  async listParticipants(eventId) { return (loadDb().eventPhotographers || []).filter(x => x.eventId === Number(eventId)); },
  async getParticipant(eventId, photographerId) { return (loadDb().eventPhotographers || []).find(x => x.eventId === Number(eventId) && x.photographerId === Number(photographerId)) || null; },
  async listJoinedEventIds(photographerId) { return (loadDb().eventPhotographers || []).filter(x => x.photographerId === Number(photographerId)).map(x => x.eventId); },
  async setDisplayName(userId, name) { const db = loadDb(); const u = db.users.find(x => x.id === Number(userId)); if (!u) return null; u.displayName = name; saveDb(db); return u; },
  async listEvents() { return loadDb().events.slice().sort((a, b) => b.id - a.id).map(e => ({ ...e, photoCount: loadDb().photos.filter(p => p.eventId === e.id).length })); },
  async getEvent(id) { return loadDb().events.find(e => e.id === Number(id)) || null; },
  async createEvent(e) { const db = loadDb(); const row = { id: nextId(db, 'event'), freeMode: true, priceMxn: 20, createdAt: new Date().toISOString(), ...e }; db.events.push(row); saveDb(db); return row; },
  async updateEvent(id, patch) { const db = loadDb(); const e = db.events.find(x => x.id === Number(id)); if (!e) return null; Object.assign(e, patch); saveDb(db); return e; },
  async deleteEvent(id) { const db = loadDb(); const ev = db.events.find(x => x.id === Number(id)); db.eventPhotographers = (db.eventPhotographers || []).filter(x => x.eventId !== Number(id)); db.photoAlerts = (db.photoAlerts || []).filter(x => x.eventId !== Number(id)); const gone = db.photos.filter(p => p.eventId === Number(id)); for (const p of gone) { if (p.filePath) { try { fs.unlinkSync(p.filePath); } catch (_) {} } if (p.thumbPath) { try { fs.unlinkSync(p.thumbPath); } catch (_) {} } } if (ev && ev.coverPath) { try { fs.unlinkSync(ev.coverPath); } catch (_) {} } db.events = db.events.filter(e => e.id !== Number(id)); db.photos = db.photos.filter(p => p.eventId !== Number(id)); saveDb(db); return { photos: gone.length }; },
  async setEventCover(id, f) { const db = loadDb(); const ev = db.events.find(x => x.id === Number(id)); if (!ev) return null; fs.mkdirSync(UPLOAD_DIR, { recursive: true }); if (ev.coverPath) { try { fs.unlinkSync(ev.coverPath); } catch (_) {} } const ext = f.mimeType === 'image/png' ? 'png' : 'jpg'; const coverPath = path.join(UPLOAD_DIR, `cover-${id}-${Date.now()}.${ext}`); fs.writeFileSync(coverPath, f.fileBuffer); ev.coverPath = coverPath; saveDb(db); return coverPath; },
  async getEventCover(id) { const ev = await this.getEvent(id); if (!ev || !ev.coverPath) return null; try { return { bytes: fs.readFileSync(ev.coverPath), mimeType: String(ev.coverPath).endsWith('.png') ? 'image/png' : 'image/jpeg' }; } catch (_) { return null; } },
  async listPhotos(eventId) { return loadDb().photos.filter(p => p.eventId === Number(eventId)); },
  async getPhoto(id) { return loadDb().photos.find(p => p.id === Number(id)) || null; },
  async createPhoto(p) {
    const db = loadDb();
    const id = nextId(db, 'photo');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safe = String(p.filename || 'foto.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(UPLOAD_DIR, `${id}-${safe}`);
    fs.writeFileSync(filePath, p.fileBuffer);
    // Miniatura opcional para la galería (misma idea que en Supabase).
    let thumbPath = '';
    if (p.thumbBuffer && p.thumbBuffer.length) {
      thumbPath = path.join(UPLOAD_DIR, `${id}-thumb.jpg`);
      try { fs.writeFileSync(thumbPath, p.thumbBuffer); } catch (_) { thumbPath = ''; }
    }
    const row = { id, eventId: p.eventId, filename: p.filename, mimeType: p.mimeType, bibs: p.bibs || [], price: p.price || 0, photographerId: p.photographerId != null ? Number(p.photographerId) : null, filePath, thumbPath, widthPx: p.widthPx != null ? Number(p.widthPx) : null, heightPx: p.heightPx != null ? Number(p.heightPx) : null, sizeKb: p.sizeKb != null ? Number(p.sizeKb) : null, createdAt: new Date().toISOString() };
    db.photos.push(row); saveDb(db); return row;
  },
  // Backfill de miniaturas (fotos viejas sin thumbPath): guarda el archivo
  // de la miniatura y apunta la fila a él. Misma ruta que createPhoto.
  async saveThumbBuffer(photoId, buffer) { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); const thumbPath = path.join(UPLOAD_DIR, `${Number(photoId)}-thumb.jpg`); fs.writeFileSync(thumbPath, buffer); return thumbPath; },
  async setPhotoThumb(id, thumbPath) { const db = loadDb(); const p = db.photos.find(x => x.id === Number(id)); if (!p) return null; p.thumbPath = thumbPath || ''; saveDb(db); return { ...p }; },
  async updatePhoto(id, patch) { const db = loadDb(); const p = db.photos.find(x => x.id === Number(id)); if (!p) return null; Object.assign(p, patch); saveDb(db); return p; },
  async deletePhoto(id) { const db = loadDb(); const p = db.photos.find(x => x.id === Number(id)); if (p && p.filePath) { try { fs.unlinkSync(p.filePath); } catch (_) {} } if (p && p.thumbPath) { try { fs.unlinkSync(p.thumbPath); } catch (_) {} } db.photos = db.photos.filter(x => x.id !== Number(id)); saveDb(db); },
  async addDownload(d) { const db = loadDb(); const row = { id: nextId(db, 'download'), createdAt: new Date().toISOString(), ...d }; db.downloads.push(row); saveDb(db); return row; },
  async listDownloadsByUser(userId) { return loadDb().downloads.filter(d => d.userId === Number(userId)); },
  // Quita de "Mis fotos" solo el registro de descarga de ese usuario y esa
  // foto (la foto del álbum NO se borra). Devuelve cuántos se quitaron.
  async removeDownloadsByUserPhoto(userId, photoId) { const db = loadDb(); const before = db.downloads.length; db.downloads = db.downloads.filter(d => !(d.userId === Number(userId) && d.photoId === Number(photoId))); const removed = before - db.downloads.length; if (removed) saveDb(db); return removed; },
  async listAllDownloads() { return loadDb().downloads.slice().sort((a, b) => b.id - a.id); },
  // ---- Pagos a fotógrafos ----
  // Un payout = un pago que Orlan YA envió. Sus descargas quedan ligadas
  // con payout_id y salen del saldo pendiente.
  async createPayout(p) {
    const db = loadDb();
    if (!db.payouts) db.payouts = [];
    if (!db.seq.payout) db.seq.payout = 1;
    const row = { id: nextId(db, 'payout'), status: 'pending', paidAt: null, createdAt: new Date().toISOString(), ...p };
    db.payouts.push(row); saveDb(db); return row;
  },
  async listPayouts() { return (loadDb().payouts || []).slice().sort((a, b) => b.id - a.id); },
  async listPayoutsByPhotographer(photographerId) { return (loadDb().payouts || []).filter(p => p.photographerId === Number(photographerId)).sort((a, b) => b.id - a.id); },
  async updateDownloadsPayout(ids, payoutId) {
    const db = loadDb();
    const set = new Set((ids || []).map(Number));
    let n = 0;
    // Solo las que aún no están liquidadas: si dos clics llegan juntos,
    // el segundo no le roba las descargas al primer pago.
    for (const d of db.downloads) if (set.has(Number(d.id)) && d.payoutId == null) { d.payoutId = payoutId; n++; }
    if (n) saveDb(db);
    return n;
  },
  // ---- Solicitudes de fotógrafos ----
  // La solicitud nace 'pending'. inviteToken/inviteExpiresAt se llenan
  // al aprobarla; photographerId cuando el fotógrafo crea su cuenta
  // con el link de invitación.
  async createApplication(a) {
    const db = loadDb();
    if (!db.applications) db.applications = [];
    if (!db.seq.application) db.seq.application = 1;
    const row = { id: nextId(db, 'application'), status: 'pending', inviteToken: null, inviteExpiresAt: null, photographerId: null, createdAt: new Date().toISOString(), ...a };
    db.applications.push(row); saveDb(db); return row;
  },
  async getApplicationById(id) { return (loadDb().applications || []).find(x => x.id === Number(id)) || null; },
  async getApplicationByToken(token) { return (loadDb().applications || []).find(x => x.inviteToken === String(token)) || null; },
  async listApplications() { return (loadDb().applications || []).slice().sort((a, b) => b.id - a.id); },
  // ---- Notificaciones: avisos del dueño a los fotógrafos + noticias
  // para atletas (audience: 'athletes' | 'photographers' | 'all').
  // Sin audience (fila vieja) se trata como solo fotógrafos, como antes.
  // Un aviso con userId es para UNA cuenta (pago confirmado): solo esa
  // cuenta lo ve, sin importar el grupo.
  async createAnnouncement(a) {
    const db = loadDb();
    if (!db.announcements) db.announcements = [];
    if (!db.seq.announcement) db.seq.announcement = 1;
    const row = { id: nextId(db, 'announcement'), title: a.title, body: a.body, audience: a.audience || 'photographers', userId: a.userId != null ? Number(a.userId) : null, createdBy: a.createdBy || null, createdAt: new Date().toISOString() };
    db.announcements.push(row); saveDb(db); return row;
  },
  async listAnnouncements() { return (loadDb().announcements || []).slice().sort((a, b) => b.id - a.id); },
  // ---- Códigos de descuento (2026-11-18) ----
  // Un código = un evento + un % + maxUses usos. maxUses=1 es el código
  // de un solo uso de antes; maxUses=N (hasta 1000) es el código
  // compartido: cada cuenta solo una vez (lo fuerza UNIQUE en
  // discount_code_redemptions) y se apaga solo al llegar a N usos
  // confirmados. La unicidad del código la garantiza el índice único
  // en Supabase (y la revisión previa en handlers.js); aquí el insert
  // solo guarda.
  async createDiscountCode(c) {
    const db = loadDb();
    if (!db.discountCodes) db.discountCodes = [];
    if (!db.seq.discountCode) db.seq.discountCode = 1;
    const maxUses = Math.min(1000, Math.max(1, Math.floor(Number(c.maxUses || 1)) || 1));
    const row = { id: nextId(db, 'discountCode'), code: String(c.code || '').trim().toUpperCase(), eventId: Number(c.eventId), discountPercent: Number(c.discountPercent || 20), note: String(c.note || ''), createdBy: c.createdBy != null ? Number(c.createdBy) : null, used: false, usedBy: null, usedAt: null, paymentRequestId: null, active: true, maxUses, uses: 0, createdAt: new Date().toISOString() };
    db.discountCodes.push(row); saveDb(db); return row;
  },
  // Alta en lote (generar 500-800 códigos de golpe): un solo guardado
  // en vez de uno por código.
  async createDiscountCodes(list) {
    const db = loadDb();
    if (!db.discountCodes) db.discountCodes = [];
    if (!db.seq.discountCode) db.seq.discountCode = 1;
    const rows = (list || []).map(c => { const maxUses = Math.min(1000, Math.max(1, Math.floor(Number(c.maxUses || 1)) || 1)); return { id: nextId(db, 'discountCode'), code: String(c.code || '').trim().toUpperCase(), eventId: Number(c.eventId), discountPercent: Number(c.discountPercent || 20), note: String(c.note || ''), createdBy: c.createdBy != null ? Number(c.createdBy) : null, used: false, usedBy: null, usedAt: null, paymentRequestId: null, active: true, maxUses, uses: 0, createdAt: new Date().toISOString() }; });
    db.discountCodes.push(...rows); saveDb(db); return rows;
  },
  async getDiscountCodeById(id) { return (loadDb().discountCodes || []).find(x => x.id === Number(id)) || null; },
  async getDiscountCodeByCode(code) {
    const want = String(code || '').trim().toUpperCase();
    return (loadDb().discountCodes || []).find(x => String(x.code || '').toUpperCase() === want) || null;
  },
  // Sin eventId devuelve todos (para la revisión de unicidad al generar).
  async listDiscountCodes(eventId) {
    const all = (loadDb().discountCodes || []).slice().sort((a, b) => b.id - a.id);
    return eventId != null ? all.filter(x => Number(x.eventId) === Number(eventId)) : all;
  },
  async updateDiscountCode(id, patch) {
    const db = loadDb();
    const row = (db.discountCodes || []).find(x => x.id === Number(id));
    if (!row) return null;
    if (patch.used !== undefined) row.used = !!patch.used;
    if (patch.usedBy !== undefined) row.usedBy = patch.usedBy != null ? Number(patch.usedBy) : null;
    if (patch.usedAt !== undefined) row.usedAt = patch.usedAt;
    if (patch.paymentRequestId !== undefined) row.paymentRequestId = patch.paymentRequestId || null;
    if (patch.active !== undefined) row.active = !!patch.active;
    if (patch.maxUses !== undefined) row.maxUses = Math.min(1000, Math.max(1, Math.floor(Number(patch.maxUses)) || 1));
    if (patch.uses !== undefined) row.uses = Math.max(0, Math.floor(Number(patch.uses)) || 0);
    saveDb(db); return row;
  },
  async setDiscountCodePaymentRequest(id, clipId) { return this.updateDiscountCode(id, { paymentRequestId: clipId }); },
  // ¿Esta cuenta ya usó este código? (canje multiuso: una cuenta, un uso).
  async hasDiscountCodeRedemption(codeId, userId) {
    const db = loadDb();
    return (db.discountCodeRedemptions || []).some(r => Number(r.codeId) === Number(codeId) && Number(r.userId) === Number(userId));
  },
  // Canje multiuso: registra el uso de ESTA cuenta y suma 1 a uses, solo
  // si el código sigue activo, no está agotado y la cuenta no lo ha
  // usado antes. Cuando uses llega a maxUses, el código queda agotado
  // (used=true, como el quemado de un solo uso: para maxUses=1 esto ES
  // el comportamiento de antes). Devuelve { redeemed, reason, code }.
  // Nunca suma dos veces el mismo pago: si la cuenta ya tiene canje,
  // devuelve already sin tocar nada. Un pago fallido nunca llega aquí.
  async redeemDiscountCode(codeId, userId, clipId) {
    const db = loadDb();
    const code = (db.discountCodes || []).find(x => x.id === Number(codeId));
    if (!code) return { redeemed: false, reason: 'not-found', code: null };
    if (code.active === false) return { redeemed: false, reason: 'inactive', code };
    const maxUses = Math.max(1, Number(code.maxUses || 1));
    if (code.used || Number(code.uses || 0) >= maxUses) return { redeemed: false, reason: 'exhausted', code };
    if (!db.discountCodeRedemptions) db.discountCodeRedemptions = [];
    if (!db.seq.discountCodeRedemption) db.seq.discountCodeRedemption = 1;
    if (db.discountCodeRedemptions.some(r => Number(r.codeId) === code.id && Number(r.userId) === Number(userId))) return { redeemed: false, reason: 'already', code };
    db.discountCodeRedemptions.push({ id: nextId(db, 'discountCodeRedemption'), codeId: code.id, userId: Number(userId), paymentRequestId: String(clipId || ''), createdAt: new Date().toISOString() });
    code.uses = Number(code.uses || 0) + 1;
    if (code.uses >= maxUses) { code.used = true; code.usedBy = Number(userId); code.usedAt = new Date().toISOString(); }
    saveDb(db); return { redeemed: true, reason: null, code };
  },
  // Marca usado el código atado a un checkout de Clip, solo si sigue
  // sin usar (el primero que confirma gana; un segundo intento no lo
  // vuelve a marcar). Devuelve el código o null.
  async markDiscountCodeUsedByClipId(clipId, userId) {
    const db = loadDb();
    const row = (db.discountCodes || []).find(x => x.paymentRequestId === String(clipId) && !x.used);
    if (!row) return null;
    row.used = true; row.usedBy = Number(userId); row.usedAt = new Date().toISOString(); saveDb(db); return row;
  },
  // ---- Avisos "Avísame cuando haya fotos" ----
  // Un correo por evento: si ya existe (avisado o no), se devuelve la
  // misma fila con already=true y no se duplica.
  async createPhotoAlert(a) {
    const db = loadDb();
    if (!db.photoAlerts) db.photoAlerts = [];
    if (!db.seq.photoAlert) db.seq.photoAlert = 1;
    const email = String(a.email || '').trim().toLowerCase();
    const found = db.photoAlerts.find(x => x.eventId === Number(a.eventId) && String(x.email).toLowerCase() === email);
    if (found) return { ...found, already: true };
    const row = { id: nextId(db, 'photoAlert'), eventId: Number(a.eventId), email, notifiedAt: null, createdAt: new Date().toISOString() };
    db.photoAlerts.push(row); saveDb(db); return row;
  },
  async listPendingAlerts(eventId) { return (loadDb().photoAlerts || []).filter(x => x.eventId === Number(eventId) && !x.notifiedAt); },
  async markAlertsNotified(ids) {
    const db = loadDb();
    const set = new Set((ids || []).map(Number));
    let n = 0;
    for (const a of (db.photoAlerts || [])) if (set.has(Number(a.id)) && !a.notifiedAt) { a.notifiedAt = new Date().toISOString(); n++; }
    if (n) saveDb(db);
    return n;
  },
  async updateApplication(id, patch) { const db = loadDb(); const a = (db.applications || []).find(x => x.id === Number(id)); if (!a) return null; Object.assign(a, patch); saveDb(db); return a; },
  // Liga la solicitud al fotógrafo recién creado, solo si nadie la usó
  // antes (photographerId sigue null). Devuelve la fila o null si ya
  // estaba ligada (carrera entre dos registros con el mismo link).
  async linkApplication(token, photographerId) {
    const db = loadDb();
    const a = (db.applications || []).find(x => x.inviteToken === String(token));
    if (!a || a.photographerId != null) return null;
    a.photographerId = Number(photographerId); saveDb(db); return a;
  },
  // ---- Estadísticas: vistas (foto / evento / búsqueda) ----
  // Una vista por visitante por foto / evento / dorsal por día (UTC).
  async recordView(v) {
    const db = loadDb();
    if (!db.views) db.views = [];
    if (!db.seq.view) db.seq.view = 1;
    const row = { id: nextId(db, 'view'), kind: v.kind, photoId: v.photoId != null ? Number(v.photoId) : null, eventId: v.eventId != null ? Number(v.eventId) : null, bib: v.bib || '', viewerKey: v.viewerKey, createdAt: new Date().toISOString() };
    db.views.push(row); saveDb(db); return row;
  },
  async hasViewToday(v) {
    const db = loadDb();
    const today = new Date().toISOString().slice(0, 10);
    return (db.views || []).some(x => x.kind === v.kind
      && (x.photoId == null ? null : Number(x.photoId)) === (v.photoId != null ? Number(v.photoId) : null)
      && (x.eventId == null ? null : Number(x.eventId)) === (v.eventId != null ? Number(v.eventId) : null)
      && (x.bib || '') === (v.bib || '')
      && x.viewerKey === v.viewerKey
      && String(x.createdAt || '').slice(0, 10) === today);
  },
  async listViews() { return (loadDb().views || []).slice().sort((a, b) => b.id - a.id); },
  async createPayment(p) { const db = loadDb(); const row = { id: nextId(db, 'payment'), currency: 'MXN', status: 'pending', receiptNo: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...p }; db.payments.push(row); saveDb(db); return row; },
  async getPaymentByClipId(id) { return loadDb().payments.find(x => x.clipPaymentRequestId === String(id)) || null; },
  // Todas las filas de un checkout (un carrito = varias filas con el
  // mismo payment_request_id), en orden de creación.
  async getPaymentsByClipId(id) { return loadDb().payments.filter(x => x.clipPaymentRequestId === String(id)).sort((a, b) => a.id - b.id); },
  async getPaymentByExternalRef(ref) { return loadDb().payments.find(x => x.externalReference === String(ref)) || null; },
  async getPaymentById(id) { return loadDb().payments.find(x => x.id === Number(id)) || null; },
  async getLatestPaymentByUserPhoto(userId, photoId) { const rows = loadDb().payments.filter(x => x.userId === Number(userId) && x.photoId === Number(photoId)).sort((a, b) => b.id - a.id); return rows[0] || null; },
  async updatePaymentStatus(id, patch) { const db = loadDb(); const p = db.payments.find(x => x.id === Number(id)); if (!p) return null; if (patch.status !== undefined) p.status = patch.status; if (patch.receiptNo !== undefined) p.receiptNo = patch.receiptNo; p.updatedAt = new Date().toISOString(); saveDb(db); return p; },
  async hasDownload(userId, photoId) { return loadDb().downloads.some(d => d.userId === Number(userId) && d.photoId === Number(photoId)); },
  // ¿Alguien ya PAGÓ por esta foto? Una descarga con amount > 0 es una
  // venta: esa foto no se puede borrar (el comprador perdería lo que
  // pagó). Las descargas gratis (amount 0) no bloquean el borrado.
  async hasPaidDownload(photoId) { return loadDb().downloads.some(d => d.photoId === Number(photoId) && Number(d.amount || 0) > 0); },
  async readPhotoBytes(photo) { return fs.readFileSync(photo.filePath); },
  // Miniatura de la galería: devuelve null si la foto no tiene (fotos
  // viejas subidas antes de las miniaturas) para caer a la foto completa.
  async readThumbBytes(photo) {
    if (!photo || !photo.thumbPath) return null;
    try { return fs.readFileSync(photo.thumbPath); } catch (_) { return null; }
  },
};

// ---------------- Adaptador Supabase ----------------
let supabaseClient = null;
function supabase() {
  if (supabaseClient) return supabaseClient;
  // Limpieza fuerte: la llave/URL pegadas pueden traer un salto de línea
  // o un carácter invisible EN MEDIO del valor (no solo al final), y eso
  // hace que fetch falle con "invalid header value". Solo quedan los
  // caracteres ASCII imprimibles, que es todo lo que una llave o URL válida
  // puede contener.
  // Además la URL debe ser SOLO el proyecto (https://<ref>.supabase.co):
  // si trae /rest/v1 o /auth/v1 al final, el cliente lo duplica y PostgREST
  // responde "Invalid path specified in request URL" (PGRST125).
  const clean = (v) => String(v || '').replace(/[^\x21-\x7E]/g, '');
  const cleanUrl = (v) => clean(v).replace(/\/(rest|auth)\/v1\/?$/i, '').replace(/\/+$/, '');
  const url = cleanUrl(process.env.SUPABASE_URL);
  const key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) throw new Error('Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Sin ellas, en Vercel los datos no se comparten ni persisten.');
  let createClient;
  try { ({ createClient } = require('@supabase/supabase-js')); } catch (_) {
    throw new Error('Falta el paquete @supabase/supabase-js. Corre: npm install');
  }
  supabaseClient = createClient(url, key, { auth: { persistSession: false } });
  return supabaseClient;
}

function mapUser(r) { return r ? { id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash, role: r.role, tipClabe: r.tip_clabe || '', isOwner: !!r.is_owner, approved: r.approved !== false, payoutClabe: r.payout_clabe || '', displayName: r.display_name || '', lastAnnouncementsSeenAt: r.last_announcements_seen_at || null, createdAt: r.created_at } : null; }
function mapEvent(r, photoCount) { return r ? { id: r.id, photographerId: r.photographer_id, name: r.name, sport: r.sport, eventDate: r.event_date, location: r.location, freeMode: r.free_mode, priceMxn: Number(r.price_mxn || 20), coverPath: r.cover_path || '', isHidden: !!r.is_hidden, isExclusive: !!r.is_exclusive, isUpcoming: !!r.is_upcoming, createdAt: r.created_at, photoCount } : null; }
function mapPhoto(r) { return r ? { id: r.id, eventId: r.event_id, filename: r.filename, mimeType: r.mime_type, bibs: r.bibs || [], price: Number(r.price || 0), photographerId: r.photographer_id != null ? Number(r.photographer_id) : null, storagePath: r.storage_path, thumbPath: r.thumb_path || '', widthPx: r.width_px != null ? Number(r.width_px) : null, heightPx: r.height_px != null ? Number(r.height_px) : null, sizeKb: r.size_kb != null ? Number(r.size_kb) : null, createdAt: r.created_at } : null; }
// Aviso "Avísame cuando haya fotos": un correo por evento; notified_at se
// llena cuando se mandó el aviso (una sola vez por correo y evento).
function mapPhotoAlert(r) { return r ? { id: r.id, eventId: r.event_id, email: r.email, notifiedAt: r.notified_at || null, createdAt: r.created_at } : null; }
function mapDownload(r) { return r ? { id: r.id, userId: r.user_id, photoId: r.photo_id, eventId: r.event_id, amount: Number(r.amount || 0), payoutId: r.payout_id != null ? Number(r.payout_id) : null, createdAt: r.created_at } : null; }
function mapPayout(r) { return r ? { id: r.id, photographerId: r.photographer_id, amountMxn: Number(r.amount_mxn || 0), orlanFeeMxn: Number(r.orlan_fee_mxn || 0), clipFeeMxn: Number(r.clip_fee_mxn || 0), status: r.status, createdAt: r.created_at, paidAt: r.paid_at || null } : null; }
function mapView(r) { return r ? { id: r.id, kind: r.kind, photoId: r.photo_id, eventId: r.event_id, bib: r.bib || '', viewerKey: r.viewer_key, createdAt: r.created_at } : null; }
function mapApplication(r) { return r ? { id: r.id, name: r.name, city: r.city, phone: r.phone, events: r.events, camera: r.camera || '', sampleLink: r.sample_link, specialty: r.specialty || '', dorsalExp: r.dorsal_exp || '', availability: r.availability || '', clabe: r.clabe || '', message: r.message || '', status: r.status, inviteToken: r.invite_token || null, inviteExpiresAt: r.invite_expires_at || null, photographerId: r.photographer_id != null ? Number(r.photographer_id) : null, createdAt: r.created_at } : null; }
function mapAnnouncement(r) { return r ? { id: r.id, title: r.title, body: r.body, audience: r.audience || 'photographers', userId: r.user_id != null ? Number(r.user_id) : null, createdBy: r.created_by != null ? Number(r.created_by) : null, createdAt: r.created_at } : null; }
// Código de descuento: un evento, un % y maxUses usos (1 = un solo uso,
// como antes). uses cuenta los pagos confirmados. Si la tabla aún no
// existe en vivo (falta correr el SQL), las lecturas devuelven vacío/null.
// Si faltan las columnas nuevas (SQL viejo), uses=0 y maxUses=1: el
// código se comporta como uno de un solo uso.
function mapDiscountCode(r) { return r ? { id: r.id, code: r.code, eventId: r.event_id, discountPercent: Number(r.discount_percent || 20), note: r.note || '', createdBy: r.created_by != null ? Number(r.created_by) : null, used: !!r.used, usedBy: r.used_by != null ? Number(r.used_by) : null, usedAt: r.used_at || null, paymentRequestId: r.payment_request_id || null, active: r.active !== false, maxUses: Number(r.max_uses || 1), uses: Number(r.uses || 0), createdAt: r.created_at } : null; }
function mapPayment(r) { return r ? { id: r.id, clipPaymentRequestId: r.clip_payment_request_id, externalReference: r.external_reference, userId: r.user_id, photoId: r.photo_id, eventId: r.event_id, amount: Number(r.amount || 0), currency: r.currency || 'MXN', status: r.status, receiptNo: r.receipt_no || '', discountCodeId: r.discount_code_id != null ? Number(r.discount_code_id) : null, createdAt: r.created_at, updatedAt: r.updated_at } : null; }

const supabaseStore = {
  kind: 'supabase',
  async photographerExists() { const { count } = await supabase().from('users').select('id', { count: 'exact', head: true }).eq('role', 'photographer'); return (count || 0) > 0; },
  async createUser(u) { const { data, error } = await supabase().from('users').insert({ name: u.name, email: u.email, password_hash: u.passwordHash, role: u.role, is_owner: !!u.isOwner, approved: u.approved !== false, payout_clabe: u.payoutClabe || '' }).select().single(); if (error) throw new Error(error.message); return mapUser(data); },
  async findUserByEmail(email) { const { data } = await supabase().from('users').select().ilike('email', email).maybeSingle(); return mapUser(data); },
  async findUserById(id) { const { data } = await supabase().from('users').select().eq('id', id).maybeSingle(); return mapUser(data); },
  async updateUserPassword(id, passwordHash) { const { data, error } = await supabase().from('users').update({ password_hash: passwordHash }).eq('id', id).select().single(); if (error) throw new Error(error.message); return mapUser(data); },
  async setTipClabe(userId, clabe) { const { data, error } = await supabase().from('users').update({ tip_clabe: clabe }).eq('id', userId).select().single(); if (error) throw new Error(error.message); return mapUser(data); },
  async setPayoutClabe(userId, clabe) { const { data, error } = await supabase().from('users').update({ payout_clabe: clabe }).eq('id', userId).select().single(); if (error) throw new Error(error.message); return mapUser(data); },
  // ---- Eventos compartidos ----
  // Si la tabla aún no existe en vivo (falta correr el SQL), las lecturas
  // devuelven vacío/null y el evento se comporta como antes (un solo
  // fotógrafo: su creador). Las escrituras sí fallan y avisan.
  async joinEvent(eventId, photographerId, priceMxn) {
    const { data, error } = await supabase().from('event_photographers').upsert({ event_id: eventId, photographer_id: photographerId, price_mxn: priceMxn }, { onConflict: 'event_id,photographer_id' }).select().single();
    if (error) throw new Error(error.message);
    return { eventId: data.event_id, photographerId: data.photographer_id, priceMxn: Number(data.price_mxn || 20), joinedAt: data.joined_at };
  },
  async leaveEvent(eventId, photographerId) {
    const { error, count } = await supabase().from('event_photographers').delete({ count: 'exact' }).eq('event_id', eventId).eq('photographer_id', photographerId);
    if (error) throw new Error(error.message);
    return count || 0;
  },
  async listParticipants(eventId) {
    try {
      const { data, error } = await supabase().from('event_photographers').select().eq('event_id', eventId).order('joined_at');
      if (error) return [];
      return (data || []).map(r => ({ eventId: r.event_id, photographerId: r.photographer_id, priceMxn: Number(r.price_mxn || 20), joinedAt: r.joined_at }));
    } catch (_) { return []; }
  },
  async getParticipant(eventId, photographerId) {
    try {
      const { data, error } = await supabase().from('event_photographers').select().eq('event_id', eventId).eq('photographer_id', photographerId).maybeSingle();
      if (error || !data) return null;
      return { eventId: data.event_id, photographerId: data.photographer_id, priceMxn: Number(data.price_mxn || 20), joinedAt: data.joined_at };
    } catch (_) { return null; }
  },
  async listJoinedEventIds(photographerId) {
    try {
      const { data, error } = await supabase().from('event_photographers').select('event_id').eq('photographer_id', photographerId);
      if (error) return [];
      return (data || []).map(r => r.event_id);
    } catch (_) { return []; }
  },
  async setDisplayName(userId, name) {
    const { data, error } = await supabase().from('users').update({ display_name: name }).eq('id', userId).select().single();
    if (error) throw new Error(error.message);
    return mapUser(data);
  },
  async listPhotographers() { const { data } = await supabase().from('users').select().eq('role', 'photographer').order('id'); return (data || []).map(mapUser); },
  async updateUser(id, patch) {
    const p = {};
    if (patch.approved !== undefined) p.approved = !!patch.approved;
    if (patch.isOwner !== undefined) p.is_owner = !!patch.isOwner;
    if (patch.payoutClabe !== undefined) p.payout_clabe = patch.payoutClabe;
    if (patch.displayName !== undefined) p.display_name = patch.displayName;
    if (patch.lastAnnouncementsSeenAt !== undefined) p.last_announcements_seen_at = patch.lastAnnouncementsSeenAt;
    if (patch.tipClabe !== undefined) p.tip_clabe = patch.tipClabe;
    const { data, error } = await supabase().from('users').update(p).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return mapUser(data);
  },
  async listEvents() {
    const { data } = await supabase().from('events').select().order('id', { ascending: false });
    const out = [];
    for (const e of data || []) { const { count } = await supabase().from('photos').select('id', { count: 'exact', head: true }).eq('event_id', e.id); out.push(mapEvent(e, count || 0)); }
    return out;
  },
  async getEvent(id) { const { data } = await supabase().from('events').select().eq('id', id).maybeSingle(); return mapEvent(data); },
  async createEvent(e) {
    const ins = { photographer_id: e.photographerId, name: e.name, sport: e.sport, event_date: e.eventDate, location: e.location, free_mode: e.freeMode !== false, price_mxn: e.priceMxn !== undefined ? e.priceMxn : 20 };
    // Álbum exclusivo: la columna solo se manda cuando es exclusivo, para
    // que crear eventos normales no se rompa si aún no se corrió el SQL
    // (falta el ALTER): si la columna no existe, se reintenta sin ella y
    // el evento queda como álbum normal, igual que con las columnas de
    // metadatos de las fotos.
    if (e.isExclusive === true) ins.is_exclusive = true;
    if (e.isUpcoming === true) ins.is_upcoming = true;
    let { data, error } = await supabase().from('events').insert(ins).select().single();
    if (error && /is_exclusive/i.test(error.message || '')) {
      delete ins.is_exclusive;
      ({ data, error } = await supabase().from('events').insert(ins).select().single());
    }
    // Misma tolerancia para is_upcoming: si falta la columna, el evento
    // se crea como álbum normal (el dueño lo puede marcar después, una
    // vez corrido el SQL).
    if (error && /is_upcoming/i.test(error.message || '')) {
      delete ins.is_upcoming;
      ({ data, error } = await supabase().from('events').insert(ins).select().single());
    }
    if (error) throw new Error(error.message); return mapEvent(data, 0);
  },
  async updateEvent(id, patch) {
    const p = {}; if (patch.freeMode !== undefined) p.free_mode = patch.freeMode;
    if (patch.priceMxn !== undefined) p.price_mxn = patch.priceMxn;
    if (patch.isHidden !== undefined) p.is_hidden = patch.isHidden;
    if (patch.isExclusive !== undefined) p.is_exclusive = patch.isExclusive;
    if (patch.isUpcoming !== undefined) p.is_upcoming = patch.isUpcoming;
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.coverPath !== undefined) p.cover_path = patch.coverPath;
    const { data } = await supabase().from('events').update(p).eq('id', id).select().single(); return mapEvent(data);
  },
  async setEventCover(id, f) {
    const ev = await this.getEvent(id);
    const ext = f.mimeType === 'image/png' ? 'png' : 'jpg';
    const coverPath = `covers/${id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const { error: upErr } = await supabase().storage.from('photos').upload(coverPath, f.fileBuffer, { contentType: f.mimeType, upsert: true });
    if (upErr) throw new Error('No se pudo subir la portada: ' + upErr.message);
    if (ev && ev.coverPath) { try { await supabase().storage.from('photos').remove([ev.coverPath]); } catch (_) {} }
    await supabase().from('events').update({ cover_path: coverPath }).eq('id', id);
    return coverPath;
  },
  async getEventCover(id) {
    const ev = await this.getEvent(id);
    if (!ev || !ev.coverPath) return null;
    const { data, error } = await supabase().storage.from('photos').download(ev.coverPath);
    if (error || !data) return null;
    return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: String(ev.coverPath).endsWith('.png') ? 'image/png' : 'image/jpeg' };
  },
  async deleteEvent(id) {
    const ev = await this.getEvent(id);
    const photos = await this.listPhotos(id);
    const paths = photos.map(p => p.storagePath).filter(Boolean);
    for (const p of photos) if (p.thumbPath) paths.push(p.thumbPath);
    if (ev && ev.coverPath) paths.push(ev.coverPath);
    for (let i = 0; i < paths.length; i += 100) { await supabase().storage.from('photos').remove(paths.slice(i, i + 100)); }
    await supabase().from('photos').delete().eq('event_id', id);
    try { await supabase().from('photo_alerts').delete().eq('event_id', id); } catch (_) {}
    try { await supabase().from('event_photographers').delete().eq('event_id', id); } catch (_) {}
    await supabase().from('events').delete().eq('id', id);
    return { photos: photos.length };
  },
  async listPhotos(eventId) { const { data } = await supabase().from('photos').select().eq('event_id', eventId).order('id'); return (data || []).map(mapPhoto); },
  async getPhoto(id) { const { data } = await supabase().from('photos').select().eq('id', id).maybeSingle(); return mapPhoto(data); },
  async createPhoto(p) {
    const ext = (String(p.filename || 'foto.jpg').split('.').pop() || 'jpg').toLowerCase();
    const storagePath = `photos/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const { error: upErr } = await supabase().storage.from('photos').upload(storagePath, p.fileBuffer, { contentType: p.mimeType, upsert: true });
    if (upErr) throw new Error('No se pudo subir la foto al bucket: ' + upErr.message);
    let ins = { event_id: p.eventId, filename: p.filename, mime_type: p.mimeType, bibs: p.bibs || [], price: p.price || 0, storage_path: storagePath };
    if (p.photographerId != null) ins.photographer_id = p.photographerId;
    // Metadatos de la foto (resolución y tamaño, para la vista ampliada):
    // los manda el cliente al subir. Si las columnas aún no existen en
    // vivo (falta el ALTER), se reintenta sin ellas, igual que con
    // photographer_id: la foto queda guardada sin metadatos.
    if (p.widthPx != null) ins.width_px = Number(p.widthPx);
    if (p.heightPx != null) ins.height_px = Number(p.heightPx);
    if (p.sizeKb != null) ins.size_kb = Number(p.sizeKb);
    let { data, error } = await supabase().from('photos').insert(ins).select().single();
    // Si la columna photographer_id aún no existe en vivo (falta el
    // ALTER), reintentar sin ella: la foto queda guardada y su dueño se
    // resuelve por el evento, como antes. Lo mismo con las columnas de
    // metadatos (width_px / height_px / size_kb).
    if (error && /photographer_id|width_px|height_px|size_kb/i.test(error.message || '')) {
      delete ins.photographer_id; delete ins.width_px; delete ins.height_px; delete ins.size_kb;
      ({ data, error } = await supabase().from('photos').insert(ins).select().single());
    }
    if (error) throw new Error(error.message);
    // Miniatura opcional para que la galería cargue rápido: se sube a
    // thumbs/ DESPUÉS de crear la fila. Así, si la columna thumb_path aún
    // no existe en la base en vivo (falta correr el ALTER), la subida no se
    // rompe: la foto queda guardada y la galería usa la foto completa.
    if (p.thumbBuffer && p.thumbBuffer.length) {
      const thumbPath = `thumbs/${data.id}-${crypto.randomBytes(6).toString('hex')}.jpg`;
      const { error: thErr } = await supabase().storage.from('photos').upload(thumbPath, p.thumbBuffer, { contentType: 'image/jpeg', upsert: true });
      if (!thErr) {
        const { error: updErr } = await supabase().from('photos').update({ thumb_path: thumbPath }).eq('id', data.id);
        if (!updErr) return mapPhoto({ ...data, thumb_path: thumbPath });
        try { await supabase().storage.from('photos').remove([thumbPath]); } catch (_) {}
      }
    }
    return mapPhoto(data);
  },
  // Backfill de miniaturas (fotos viejas sin thumb_path): sube el archivo
  // a thumbs/ y apunta la fila a él. Misma ruta que createPhoto.
  async saveThumbBuffer(photoId, buffer) {
    const thumbPath = `thumbs/${Number(photoId)}-${crypto.randomBytes(6).toString('hex')}.jpg`;
    const { error } = await supabase().storage.from('photos').upload(thumbPath, buffer, { contentType: 'image/jpeg', upsert: true });
    if (error) throw new Error('No se pudo subir la miniatura: ' + error.message);
    return thumbPath;
  },
  async setPhotoThumb(id, thumbPath) {
    const { data, error } = await supabase().from('photos').update({ thumb_path: thumbPath || '' }).eq('id', Number(id)).select().single();
    if (error) throw new Error(error.message);
    return mapPhoto(data);
  },
  async updatePhoto(id, patch) {
    const p = {}; if (patch.bibs !== undefined) p.bibs = patch.bibs; if (patch.price !== undefined) p.price = patch.price;
    // Metadatos de la vista ampliada (los guarda /api/photo-meta la
    // primera vez que se calculan, para no volver a leer la foto).
    if (patch.widthPx !== undefined && patch.widthPx != null) p.width_px = Number(patch.widthPx);
    if (patch.heightPx !== undefined && patch.heightPx != null) p.height_px = Number(patch.heightPx);
    if (patch.sizeKb !== undefined && patch.sizeKb != null) p.size_kb = Number(patch.sizeKb);
    const { data } = await supabase().from('photos').update(p).eq('id', id).select().single(); return mapPhoto(data);
  },
  async deletePhoto(id) { const ph = await this.getPhoto(id); if (ph && ph.storagePath) await supabase().storage.from('photos').remove([ph.storagePath]); if (ph && ph.thumbPath) { try { await supabase().storage.from('photos').remove([ph.thumbPath]); } catch (_) {} } await supabase().from('photos').delete().eq('id', id); },
  async addDownload(d) { const { data } = await supabase().from('downloads').insert({ user_id: d.userId, photo_id: d.photoId, event_id: d.eventId, amount: d.amount || 0 }).select().single(); return data; },
  async listDownloadsByUser(userId) { const { data } = await supabase().from('downloads').select().eq('user_id', userId).order('id', { ascending: false }); return (data || []).map(mapDownload); },
  async removeDownloadsByUserPhoto(userId, photoId) { const { data } = await supabase().from('downloads').delete().eq('user_id', userId).eq('photo_id', photoId).select('id'); return (data || []).length; },
  async listAllDownloads() { const { data } = await supabase().from('downloads').select().order('id', { ascending: false }); return (data || []).map(mapDownload); },
  // ---- Pagos a fotógrafos ----
  async createPayout(p) { const { data, error } = await supabase().from('payouts').insert({ photographer_id: p.photographerId, amount_mxn: p.amountMxn, orlan_fee_mxn: p.orlanFeeMxn, clip_fee_mxn: p.clipFeeMxn, status: p.status || 'pending', paid_at: p.paidAt || null }).select().single(); if (error) throw new Error(error.message); return mapPayout(data); },
  async listPayouts() { const { data } = await supabase().from('payouts').select().order('id', { ascending: false }); return (data || []).map(mapPayout); },
  async listPayoutsByPhotographer(photographerId) { const { data } = await supabase().from('payouts').select().eq('photographer_id', photographerId).order('id', { ascending: false }); return (data || []).map(mapPayout); },
  async updateDownloadsPayout(ids, payoutId) {
    const list = (ids || []).map(Number).filter(Boolean);
    if (!list.length) return 0;
    // Solo las que aún no están liquidadas (ver fileStore).
    const { data, error } = await supabase().from('downloads').update({ payout_id: payoutId }).in('id', list).is('payout_id', null).select('id');
    if (error) throw new Error(error.message);
    return (data || []).length;
  },
  // ---- Solicitudes de fotógrafos ----
  async createApplication(a) { const { data, error } = await supabase().from('photographer_applications').insert({ name: a.name, city: a.city, phone: a.phone, events: a.events, camera: a.camera || '', sample_link: a.sampleLink, specialty: a.specialty || '', dorsal_exp: a.dorsalExp || '', availability: a.availability || '', clabe: a.clabe || '', message: a.message || '' }).select().single(); if (error) throw new Error(error.message); return mapApplication(data); },
  async getApplicationById(id) { const { data } = await supabase().from('photographer_applications').select().eq('id', id).maybeSingle(); return mapApplication(data); },
  async getApplicationByToken(token) { const { data } = await supabase().from('photographer_applications').select().eq('invite_token', token).maybeSingle(); return mapApplication(data); },
  async listApplications() { const { data } = await supabase().from('photographer_applications').select().order('id', { ascending: false }); return (data || []).map(mapApplication); },
  // ---- Notificaciones: avisos del dueño a los fotógrafos + noticias
  // para atletas (audience: 'athletes' | 'photographers' | 'all').
  // Si la tabla aún no existe en vivo (falta correr el SQL), la lectura
  // devuelve vacío y la vista muestra "No hay avisos todavía".
  // Si la columna audience aún no existe (falta correr el SQL de
  // noticias), se reintenta sin ella y la noticia queda como aviso
  // solo para fotógrafos, como antes. Si la columna user_id aún no
  // existe (falta correr el SQL del aviso de pago), NO se crea el
  // aviso: mandarlo como aviso de grupo lo vería gente que no pagó.
  async createAnnouncement(a) {
    const row = { title: a.title, body: a.body, created_by: a.createdBy || null };
    if (a.audience) row.audience = a.audience;
    if (a.userId != null) row.user_id = Number(a.userId);
    const { data, error } = await supabase().from('announcements').insert(row).select().single();
    if (!error) return mapAnnouncement(data);
    if (a.userId != null && /user_id/i.test(error.message || '')) {
      throw new Error('Falta la columna announcements.user_id: corre sql/aviso-pago-confirmado.sql');
    }
    if (a.audience && /audience/i.test(error.message || '')) {
      const retry = await supabase().from('announcements').insert({ title: a.title, body: a.body, created_by: a.createdBy || null }).select().single();
      if (retry.error) throw new Error(retry.error.message);
      return mapAnnouncement(retry.data);
    }
    throw new Error(error.message);
  },
  // ---- Avisos "Avísame cuando haya fotos" ----
  async createPhotoAlert(a) {
    const email = String(a.email || '').trim().toLowerCase();
    const { data: found } = await supabase().from('photo_alerts').select().eq('event_id', Number(a.eventId)).ilike('email', email).maybeSingle();
    if (found) return { ...mapPhotoAlert(found), already: true };
    const { data, error } = await supabase().from('photo_alerts').insert({ event_id: Number(a.eventId), email }).select().single();
    if (error) throw new Error(error.message);
    return mapPhotoAlert(data);
  },
  async listPendingAlerts(eventId) { const { data } = await supabase().from('photo_alerts').select().eq('event_id', Number(eventId)).is('notified_at', null).order('id'); return (data || []).map(mapPhotoAlert); },
  async markAlertsNotified(ids) {
    const list = (ids || []).map(Number).filter(Boolean);
    if (!list.length) return 0;
    const { data, error } = await supabase().from('photo_alerts').update({ notified_at: new Date().toISOString() }).in('id', list).is('notified_at', null).select('id');
    if (error) throw new Error(error.message);
    return (data || []).length;
  },
  async listAnnouncements() {
    try {
      const { data, error } = await supabase().from('announcements').select().order('id', { ascending: false });
      if (error) return [];
      return (data || []).map(mapAnnouncement);
    } catch (_) { return []; }
  },
  // ---- Códigos de descuento (2026-11-18) ----
  // Lecturas tolerantes (tabla sin crear → vacío/null, como
  // listAnnouncements); escrituras sí fallan y avisan.
  async createDiscountCode(c) {
    // max_uses solo se manda cuando es >1: si falta correr el SQL nuevo,
    // la columna no existe y el insert fallaría; con maxUses=1 el default
    // de la base (1) ya es lo correcto y crear códigos viejos no se rompe.
    const row = { code: String(c.code || '').trim().toUpperCase(), event_id: Number(c.eventId), discount_percent: Number(c.discountPercent || 20), note: String(c.note || ''), created_by: c.createdBy != null ? Number(c.createdBy) : null };
    if (Math.floor(Number(c.maxUses || 1)) > 1) row.max_uses = Math.min(1000, Math.floor(Number(c.maxUses)));
    const { data, error } = await supabase().from('discount_codes').insert(row).select().single();
    if (error) throw new Error(error.message);
    return mapDiscountCode(data);
  },
  // Alta en lote (generar 500-800 códigos de golpe): una sola petición.
  async createDiscountCodes(list) {
    const rows = (list || []).map(c => { const row = { code: String(c.code || '').trim().toUpperCase(), event_id: Number(c.eventId), discount_percent: Number(c.discountPercent || 20), note: String(c.note || ''), created_by: c.createdBy != null ? Number(c.createdBy) : null }; if (Math.floor(Number(c.maxUses || 1)) > 1) row.max_uses = Math.min(1000, Math.floor(Number(c.maxUses))); return row; });
    const { data, error } = await supabase().from('discount_codes').insert(rows).select();
    if (error) throw new Error(error.message);
    return (data || []).map(mapDiscountCode);
  },
  async getDiscountCodeById(id) {
    try {
      const { data, error } = await supabase().from('discount_codes').select().eq('id', Number(id)).maybeSingle();
      if (error) return null;
      return mapDiscountCode(data);
    } catch (_) { return null; }
  },
  async getDiscountCodeByCode(code) {
    try {
      const { data, error } = await supabase().from('discount_codes').select().eq('code', String(code || '').trim().toUpperCase()).maybeSingle();
      if (error) return null;
      return mapDiscountCode(data);
    } catch (_) { return null; }
  },
  async listDiscountCodes(eventId) {
    try {
      let q = supabase().from('discount_codes').select().order('id', { ascending: false });
      if (eventId != null) q = q.eq('event_id', Number(eventId));
      const { data, error } = await q;
      if (error) return [];
      return (data || []).map(mapDiscountCode);
    } catch (_) { return []; }
  },
  async updateDiscountCode(id, patch) {
    const p = {};
    if (patch.used !== undefined) p.used = !!patch.used;
    if (patch.usedBy !== undefined) p.used_by = patch.usedBy != null ? Number(patch.usedBy) : null;
    if (patch.usedAt !== undefined) p.used_at = patch.usedAt;
    if (patch.paymentRequestId !== undefined) p.payment_request_id = patch.paymentRequestId || null;
    if (patch.active !== undefined) p.active = !!patch.active;
    if (patch.maxUses !== undefined) p.max_uses = Math.min(1000, Math.max(1, Math.floor(Number(patch.maxUses)) || 1));
    if (patch.uses !== undefined) p.uses = Math.max(0, Math.floor(Number(patch.uses)) || 0);
    const { data, error } = await supabase().from('discount_codes').update(p).eq('id', Number(id)).select().single();
    if (error) throw new Error(error.message);
    return mapDiscountCode(data);
  },
  async setDiscountCodePaymentRequest(id, clipId) { return this.updateDiscountCode(id, { paymentRequestId: clipId }); },
  // ¿Esta cuenta ya usó este código? Sin tabla de canjes (falta el SQL)
  // devuelve false: el quemado viejo (used=true) sigue siendo el freno.
  async hasDiscountCodeRedemption(codeId, userId) {
    try {
      const { data, error } = await supabase().from('discount_code_redemptions').select('id').eq('code_id', Number(codeId)).eq('user_id', Number(userId)).maybeSingle();
      if (error) return false;
      return !!data;
    } catch (_) { return false; }
  },
  // Canje multiuso en Supabase (lo más atómico que permite supabase-js,
  // que no tiene transacciones): 1) se revisa el tope; 2) se inserta el
  // canje — UNIQUE(code_id, user_id) rechaza el segundo uso de la misma
  // cuenta; 3) se suma el uso con control optimista (solo si uses sigue
  // siendo el que se leyó; si otro canje corrió a la vez, se reintenta).
  // Si el tope se alcanzó mientras tanto, se borra el canje recién
  // insertado para no dejar uses inconsistente. Si faltan las columnas
  // nuevas (SQL sin correr) y el código es de un solo uso, se quema
  // como antes (used=true) para no romper los códigos viejos.
  async redeemDiscountCode(codeId, userId, clipId) {
    try {
      const code = await this.getDiscountCodeById(codeId);
      if (!code) return { redeemed: false, reason: 'not-found', code: null };
      if (code.active === false) return { redeemed: false, reason: 'inactive', code };
      const maxUses = Math.max(1, Number(code.maxUses || 1));
      if (code.used || Number(code.uses || 0) >= maxUses) return { redeemed: false, reason: 'exhausted', code };
      const { error: insErr } = await supabase().from('discount_code_redemptions').insert({ code_id: Number(codeId), user_id: Number(userId), payment_request_id: String(clipId || '') });
      if (insErr) {
        if (/duplicate|unique/i.test(insErr.message || '')) return { redeemed: false, reason: 'already', code };
        if (maxUses === 1) return this._legacyMarkDiscountCodeUsed(codeId, userId);
        throw new Error(insErr.message);
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const cur = await this.getDiscountCodeById(codeId);
        if (!cur) break;
        if (Number(cur.uses || 0) >= maxUses || cur.used) {
          await supabase().from('discount_code_redemptions').delete().eq('code_id', Number(codeId)).eq('user_id', Number(userId));
          return { redeemed: false, reason: 'exhausted', code: cur };
        }
        const nextUses = Number(cur.uses || 0) + 1;
        const upd = { uses: nextUses };
        if (nextUses >= maxUses) { upd.used = true; upd.used_by = Number(userId); upd.used_at = new Date().toISOString(); }
        const { data, error } = await supabase().from('discount_codes').update(upd).eq('id', Number(codeId)).eq('uses', Number(cur.uses || 0)).select().single();
        if (!error && data) return { redeemed: true, reason: null, code: mapDiscountCode(data) };
        if (error && /does not exist|42703/i.test(error.message || '') && maxUses === 1) {
          return this._legacyMarkDiscountCodeUsed(codeId, userId);
        }
        // Sin fila o error de carrera: otro canje incrementó a la vez;
        // se reintenta leyendo de nuevo.
      }
      await supabase().from('discount_code_redemptions').delete().eq('code_id', Number(codeId)).eq('user_id', Number(userId));
      return { redeemed: false, reason: 'retry', code };
    } catch (_) { return { redeemed: false, reason: 'error', code: null }; }
  },
  // Quemado viejo (un solo uso) sin depender de las columnas nuevas:
  // solo marca used=true si sigue sin usar. Respaldo cuando falta el SQL.
  async _legacyMarkDiscountCodeUsed(codeId, userId) {
    try {
      const { data, error } = await supabase().from('discount_codes').update({ used: true, used_by: Number(userId), used_at: new Date().toISOString() }).eq('id', Number(codeId)).eq('used', false).select().single();
      if (error) return { redeemed: false, reason: 'error', code: null };
      return { redeemed: true, reason: null, code: mapDiscountCode(data), legacy: true };
    } catch (_) { return { redeemed: false, reason: 'error', code: null }; }
  },
  // Atómico en Postgres: solo marca si sigue sin usar (used=false); el
  // segundo intento no encuentra fila y devuelve null.
  async markDiscountCodeUsedByClipId(clipId, userId) {
    try {
      const { data, error } = await supabase().from('discount_codes').update({ used: true, used_by: Number(userId), used_at: new Date().toISOString() }).eq('payment_request_id', String(clipId)).eq('used', false).select().single();
      if (error) return null;
      return mapDiscountCode(data);
    } catch (_) { return null; }
  },
  async updateApplication(id, patch) {
    const p = {};
    if (patch.status !== undefined) p.status = patch.status;
    if (patch.inviteToken !== undefined) p.invite_token = patch.inviteToken;
    if (patch.inviteExpiresAt !== undefined) p.invite_expires_at = patch.inviteExpiresAt;
    if (patch.photographerId !== undefined) p.photographer_id = patch.photographerId;
    const { data, error } = await supabase().from('photographer_applications').update(p).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return mapApplication(data);
  },
  // Atómico en Postgres: solo liga si sigue libre (photographer_id null).
  // Devuelve la fila o null si el link ya fue usado.
  async linkApplication(token, photographerId) {
    const { data, error } = await supabase().from('photographer_applications').update({ photographer_id: photographerId }).eq('invite_token', token).is('photographer_id', null).select().single();
    if (error) return null;
    return mapApplication(data);
  },
  // ---- Estadísticas: vistas (foto / evento / búsqueda) ----
  // Una vista por visitante por foto / evento / dorsal por día (UTC).
  async recordView(v) {
    const { data, error } = await supabase().from('views').insert({ kind: v.kind, photo_id: v.photoId != null ? v.photoId : null, event_id: v.eventId != null ? v.eventId : null, bib: v.bib || null, viewer_key: v.viewerKey }).select().single();
    if (error) throw new Error(error.message);
    return mapView(data);
  },
  async hasViewToday(v) {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
    let q = supabase().from('views').select('id', { count: 'exact', head: true }).eq('kind', v.kind).eq('viewer_key', v.viewerKey).gte('created_at', start).lt('created_at', end);
    if (v.photoId != null) q = q.eq('photo_id', v.photoId); else q = q.is('photo_id', null);
    if (v.eventId != null) q = q.eq('event_id', v.eventId); else q = q.is('event_id', null);
    if (v.bib) q = q.eq('bib', v.bib); else q = q.is('bib', null);
    const { count } = await q;
    return (count || 0) > 0;
  },
  // Paginado de 1000 en 1000 (límite de PostgREST por petición) hasta
  // 20000 filas: las estadísticas solo cubren las vistas más recientes
  // si la tabla pasa de ahí (ver README).
  async listViews() {
    const out = [];
    const PAGE = 1000, MAX = 20000;
    for (let from = 0; from < MAX; from += PAGE) {
      const { data } = await supabase().from('views').select().order('id', { ascending: false }).range(from, from + PAGE - 1);
      const rows = data || [];
      out.push(...rows.map(mapView));
      if (rows.length < PAGE) break;
    }
    return out;
  },
  async hasDownload(userId, photoId) { const { count } = await supabase().from('downloads').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('photo_id', photoId); return (count || 0) > 0; },
  // ¿Alguien ya PAGÓ por esta foto? Una descarga con amount > 0 es una
  // venta: esa foto no se puede borrar (el comprador perdería lo que
  // pagó). Las descargas gratis (amount 0) no bloquean el borrado.
  async hasPaidDownload(photoId) { const { count } = await supabase().from('downloads').select('id', { count: 'exact', head: true }).eq('photo_id', photoId).gt('amount', 0); return (count || 0) > 0; },
  async createPayment(p) {
    // discount_code_id ata el pago al código que usó (multiuso: un
    // código compartido tiene muchos checkouts a la vez y el campo
    // payment_request_id del código solo guarda uno). Si falta correr
    // el SQL nuevo, la columna no existe: se reintenta sin ella para
    // no romper NINGÚN pago (el canje de ese pago simplemente no se
    // registra, igual que cuando falta la tabla de códigos).
    const row = { clip_payment_request_id: p.clipPaymentRequestId, external_reference: p.externalReference, user_id: p.userId, photo_id: p.photoId, event_id: p.eventId, amount: p.amount, currency: p.currency || 'MXN', status: p.status || 'pending', receipt_no: p.receiptNo || '' };
    if (p.discountCodeId != null) row.discount_code_id = Number(p.discountCodeId);
    let res = await supabase().from('payments').insert(row).select().single();
    if (res.error && row.discount_code_id != null && /discount_code_id|does not exist|42703/i.test(res.error.message || '')) {
      delete row.discount_code_id;
      res = await supabase().from('payments').insert(row).select().single();
    }
    if (res.error) throw new Error(res.error.message);
    return mapPayment(res.data);
  },
  async getPaymentByClipId(id) { const { data } = await supabase().from('payments').select().eq('clip_payment_request_id', id).maybeSingle(); return mapPayment(data); },
  // Todas las filas de un checkout (un carrito = varias filas con el
  // mismo payment_request_id), en orden de creación.
  async getPaymentsByClipId(id) { const { data } = await supabase().from('payments').select().eq('clip_payment_request_id', id).order('id'); return (data || []).map(mapPayment); },
  async getPaymentByExternalRef(ref) { const { data } = await supabase().from('payments').select().eq('external_reference', ref).maybeSingle(); return mapPayment(data); },
  async getPaymentById(id) { const { data } = await supabase().from('payments').select().eq('id', id).maybeSingle(); return mapPayment(data); },
  async getLatestPaymentByUserPhoto(userId, photoId) { const { data } = await supabase().from('payments').select().eq('user_id', userId).eq('photo_id', photoId).order('id', { ascending: false }).limit(1).maybeSingle(); return mapPayment(data); },
  async updatePaymentStatus(id, patch) { const p = { updated_at: new Date().toISOString() }; if (patch.status !== undefined) p.status = patch.status; if (patch.receiptNo !== undefined) p.receipt_no = patch.receiptNo; const { data } = await supabase().from('payments').update(p).eq('id', id).select().single(); return mapPayment(data); },
  async readPhotoBytes(photo) {
    const { data, error } = await supabase().storage.from('photos').download(photo.storagePath);
    if (error) throw new Error('No se pudo leer la foto: ' + error.message);
    return Buffer.from(await data.arrayBuffer());
  },
  // Miniatura de la galería: null si la foto no tiene (fotos viejas) para
  // que el servidor caiga a la foto completa sin romper nada.
  async readThumbBytes(photo) {
    if (!photo || !photo.thumbPath) return null;
    const { data, error } = await supabase().storage.from('photos').download(photo.thumbPath);
    if (error) return null;
    return Buffer.from(await data.arrayBuffer());
  },
};

function getStore() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return supabaseStore;
  return fileStore;
}

module.exports = { getStore, fileStore, supabaseStore };
