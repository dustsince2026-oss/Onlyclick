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
    return { users: [], events: [], photos: [], downloads: [], seq: { user: 1, event: 1, photo: 1, download: 1 } };
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
  async listEvents() { return loadDb().events.slice().sort((a, b) => b.id - a.id).map(e => ({ ...e, photoCount: loadDb().photos.filter(p => p.eventId === e.id).length })); },
  async getEvent(id) { return loadDb().events.find(e => e.id === Number(id)) || null; },
  async createEvent(e) { const db = loadDb(); const row = { id: nextId(db, 'event'), freeMode: true, createdAt: new Date().toISOString(), ...e }; db.events.push(row); saveDb(db); return row; },
  async updateEvent(id, patch) { const db = loadDb(); const e = db.events.find(x => x.id === Number(id)); if (!e) return null; Object.assign(e, patch); saveDb(db); return e; },
  async deleteEvent(id) { const db = loadDb(); const ev = db.events.find(x => x.id === Number(id)); const gone = db.photos.filter(p => p.eventId === Number(id)); for (const p of gone) { if (p.filePath) { try { fs.unlinkSync(p.filePath); } catch (_) {} } } if (ev && ev.coverPath) { try { fs.unlinkSync(ev.coverPath); } catch (_) {} } db.events = db.events.filter(e => e.id !== Number(id)); db.photos = db.photos.filter(p => p.eventId !== Number(id)); saveDb(db); return { photos: gone.length }; },   async setEventCover(id, f) { const db = loadDb(); const ev = db.events.find(x => x.id === Number(id)); if (!ev) return null; fs.mkdirSync(UPLOAD_DIR, { recursive: true }); if (ev.coverPath) { try { fs.unlinkSync(ev.coverPath); } catch (_) {} } const ext = f.mimeType === 'image/png' ? 'png' : 'jpg'; const coverPath = path.join(UPLOAD_DIR, `cover-${id}-${Date.now()}.${ext}`); fs.writeFileSync(coverPath, f.fileBuffer); ev.coverPath = coverPath; saveDb(db); return coverPath; },   async getEventCover(id) { const ev = await this.getEvent(id); if (!ev || !ev.coverPath) return null; try { return { bytes: fs.readFileSync(ev.coverPath), mimeType: String(ev.coverPath).endsWith('.png') ? 'image/png' : 'image/jpeg' }; } catch (_) { return null; } },
  async listPhotos(eventId) { return loadDb().photos.filter(p => p.eventId === Number(eventId)); },
  async getPhoto(id) { return loadDb().photos.find(p => p.id === Number(id)) || null; },
  async createPhoto(p) {
    const db = loadDb();
    const id = nextId(db, 'photo');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safe = String(p.filename || 'foto.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(UPLOAD_DIR, `${id}-${safe}`);
    fs.writeFileSync(filePath, p.fileBuffer);
    const row = { id, eventId: p.eventId, filename: p.filename, mimeType: p.mimeType, bibs: p.bibs || [], price: p.price || 0, filePath, createdAt: new Date().toISOString() };
    db.photos.push(row); saveDb(db); return row;
  },
  async updatePhoto(id, patch) { const db = loadDb(); const p = db.photos.find(x => x.id === Number(id)); if (!p) return null; Object.assign(p, patch); saveDb(db); return p; },
  async deletePhoto(id) { const db = loadDb(); const p = db.photos.find(x => x.id === Number(id)); if (p && p.filePath) { try { fs.unlinkSync(p.filePath); } catch (_) {} } db.photos = db.photos.filter(x => x.id !== Number(id)); saveDb(db); },
  async addDownload(d) { const db = loadDb(); const row = { id: nextId(db, 'download'), createdAt: new Date().toISOString(), ...d }; db.downloads.push(row); saveDb(db); return row; },
  async listDownloadsByUser(userId) { return loadDb().downloads.filter(d => d.userId === Number(userId)); },
  async listAllDownloads() { return loadDb().downloads.slice().sort((a, b) => b.id - a.id); },
  async hasDownload(userId, photoId) { return loadDb().downloads.some(d => d.userId === Number(userId) && d.photoId === Number(photoId)); },
  async readPhotoBytes(photo) { return fs.readFileSync(photo.filePath); },
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

function mapUser(r) { return r ? { id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash, role: r.role, tipClabe: r.tip_clabe || '', createdAt: r.created_at } : null; }
function mapEvent(r, photoCount) { return r ? { id: r.id, photographerId: r.photographer_id, name: r.name, sport: r.sport, eventDate: r.event_date, location: r.location, freeMode: r.free_mode, coverPath: r.cover_path || '', createdAt: r.created_at, photoCount } : null; }
function mapPhoto(r) { return r ? { id: r.id, eventId: r.event_id, filename: r.filename, mimeType: r.mime_type, bibs: r.bibs || [], price: Number(r.price || 0), storagePath: r.storage_path, createdAt: r.created_at } : null; }
function mapDownload(r) { return r ? { id: r.id, userId: r.user_id, photoId: r.photo_id, eventId: r.event_id, amount: Number(r.amount || 0), createdAt: r.created_at } : null; }

const supabaseStore = {
  kind: 'supabase',
  async photographerExists() { const { count } = await supabase().from('users').select('id', { count: 'exact', head: true }).eq('role', 'photographer'); return (count || 0) > 0; },
  async createUser(u) { const { data, error } = await supabase().from('users').insert({ name: u.name, email: u.email, password_hash: u.passwordHash, role: u.role }).select().single(); if (error) throw new Error(error.message); return mapUser(data); },
  async findUserByEmail(email) { const { data } = await supabase().from('users').select().ilike('email', email).maybeSingle(); return mapUser(data); },
  async findUserById(id) { const { data } = await supabase().from('users').select().eq('id', id).maybeSingle(); return mapUser(data); }, 
    async updateUserPassword(id, passwordHash) { const { data, error } = await supabase().from('users').update({ password_hash: passwordHash }).eq('id', id).select().single(); if (error) throw new Error(error.message); return mapUser(data); },
  async setTipClabe(userId, clabe) { const { data, error } = await supabase().from('users').update({ tip_clabe: clabe }).eq('id', userId).select().single(); if (error) throw new Error(error.message); return mapUser(data); },
  async listEvents() {
    const { data } = await supabase().from('events').select().order('id', { ascending: false });
    const out = [];
    for (const e of data || []) { const { count } = await supabase().from('photos').select('id', { count: 'exact', head: true }).eq('event_id', e.id); out.push(mapEvent(e, count || 0)); }
    return out;
  },
  async getEvent(id) { const { data } = await supabase().from('events').select().eq('id', id).maybeSingle(); return mapEvent(data); },
  async createEvent(e) { const { data, error } = await supabase().from('events').insert({ photographer_id: e.photographerId, name: e.name, sport: e.sport, event_date: e.eventDate, location: e.location, free_mode: e.freeMode !== false }).select().single(); if (error) throw new Error(error.message); return mapEvent(data, 0); },
  async updateEvent(id, patch) {
    const p = {}; if (patch.freeMode !== undefined) p.free_mode = patch.freeMode;
    if (patch.name !== undefined) p.name = patch.name;     if (patch.coverPath !== undefined) p.cover_path = patch.coverPath;
    const { data } = await supabase().from('events').update(p).eq('id', id).select().single(); return mapEvent(data);   },   async setEventCover(id, f) {     const ev = await this.getEvent(id);     const ext = f.mimeType === 'image/png' ? 'png' : 'jpg';     const coverPath = `covers/${id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;     const { error: upErr } = await supabase().storage.from('photos').upload(coverPath, f.fileBuffer, { contentType: f.mimeType, upsert: true });     if (upErr) throw new Error('No se pudo subir la portada: ' + upErr.message);     if (ev && ev.coverPath) { try { await supabase().storage.from('photos').remove([ev.coverPath]); } catch (_) {} }     await supabase().from('events').update({ cover_path: coverPath }).eq('id', id);     return coverPath;   },   async getEventCover(id) {     const ev = await this.getEvent(id);     if (!ev || !ev.coverPath) return null;     const { data, error } = await supabase().storage.from('photos').download(ev.coverPath);     if (error) return null;     return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: String(ev.coverPath).endsWith('.png') ? 'image/png' : 'image/jpeg' };
  },
  async deleteEvent(id) {
    const ev = await this.getEvent(id);     const photos = await this.listPhotos(id);
    const paths = photos.map(p => p.storagePath).filter(Boolean);     if (ev && ev.coverPath) paths.push(ev.coverPath);
    for (let i = 0; i < paths.length; i += 100) { await supabase().storage.from('photos').remove(paths.slice(i, i + 100)); }
    await supabase().from('photos').delete().eq('event_id', id);
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
    const { data, error } = await supabase().from('photos').insert({ event_id: p.eventId, filename: p.filename, mime_type: p.mimeType, bibs: p.bibs || [], price: p.price || 0, storage_path: storagePath }).select().single();
    if (error) throw new Error(error.message); return mapPhoto(data);
  },
  async updatePhoto(id, patch) {
    const p = {}; if (patch.bibs !== undefined) p.bibs = patch.bibs; if (patch.price !== undefined) p.price = patch.price;
    const { data } = await supabase().from('photos').update(p).eq('id', id).select().single(); return mapPhoto(data);
  },
  async deletePhoto(id) { const ph = await this.getPhoto(id); if (ph && ph.storagePath) await supabase().storage.from('photos').remove([ph.storagePath]); await supabase().from('photos').delete().eq('id', id); },
  async addDownload(d) { const { data } = await supabase().from('downloads').insert({ user_id: d.userId, photo_id: d.photoId, event_id: d.eventId, amount: d.amount || 0 }).select().single(); return data; },
  async listDownloadsByUser(userId) { const { data } = await supabase().from('downloads').select().eq('user_id', userId).order('id', { ascending: false }); return (data || []).map(mapDownload); },
  async listAllDownloads() { const { data } = await supabase().from('downloads').select().order('id', { ascending: false }); return (data || []).map(mapDownload); },
  async hasDownload(userId, photoId) { const { count } = await supabase().from('downloads').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('photo_id', photoId); return (count || 0) > 0; },
  async readPhotoBytes(photo) {
    const { data, error } = await supabase().storage.from('photos').download(photo.storagePath);
    if (error) throw new Error('No se pudo leer la foto: ' + error.message);
    return Buffer.from(await data.arrayBuffer());
  },
};

function getStore() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return supabaseStore;
  return fileStore;
}

module.exports = { getStore, fileStore, supabaseStore };
