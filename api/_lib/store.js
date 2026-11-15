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
  async listEvents() { return loadDb().events.slice().sort((a, b) => b.id - a.id).map(e => ({ ...e, photoCount: loadDb().photos.filter(p => p.eventId === e.id).length })); },
  async getEvent(id) { return loadDb().events.find(e => e.id === Number(id)) || null; },
  async createEvent(e) { const db = loadDb(); const row = { id: nextId(db, 'event'), freeMode: true, createdAt: new Date().toISOString(), ...e }; db.events.push(row); saveDb(db); return row; },
  async updateEvent(id, patch) { const db = loadDb(); const e = db.events.find(x => x.id === Number(id)); if (!e) return null; Object.assign(e, patch); saveDb(db); return e; },
  async deleteEvent(id) { const db = loadDb(); db.events = db.events.filter(e => e.id !== Number(id)); db.photos = db.photos.filter(p => p.eventId !== Number(id)); saveDb(db); },
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
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Sin ellas, en Vercel los datos no se comparten ni persisten.');
  let createClient;
  try { ({ createClient } = require('@supabase/supabase-js')); } catch (_) {
    throw new Error('Falta el paquete @supabase/supabase-js. Corre: npm install');
  }
  supabaseClient = createClient(url, key, { auth: { persistSession: false } });
  return supabaseClient;
}

function mapUser(r) { return r ? { id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash, role: r.role, createdAt: r.created_at } : null; }
function mapEvent(r, photoCount) { return r ? { id: r.id, photographerId: r.photographer_id, name: r.name, sport: r.sport, eventDate: r.event_date, location: r.location, freeMode: r.free_mode, createdAt: r.created_at, photoCount } : null; }
function mapPhoto(r) { return r ? { id: r.id, eventId: r.event_id, filename: r.filename, mimeType: r.mime_type, bibs: r.bibs || [], price: Number(r.price || 0), storagePath: r.storage_path, createdAt: r.created_at } : null; }

const supabaseStore = {
  kind: 'supabase',
  async photographerExists() { const { count } = await supabase().from('users').select('id', { count: 'exact', head: true }).eq('role', 'photographer'); return (count || 0) > 0; },
  async createUser(u) { const { data, error } = await supabase().from('users').insert({ name: u.name, email: u.email, password_hash: u.passwordHash, role: u.role }).select().single(); if (error) throw new Error(error.message); return mapUser(data); },
  async findUserByEmail(email) { const { data } = await supabase().from('users').select().ilike('email', email).maybeSingle(); return mapUser(data); },
  async findUserById(id) { const { data } = await supabase().from('users').select().eq('id', id).maybeSingle(); return mapUser(data); },
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
    if (patch.name !== undefined) p.name = patch.name;
    const { data } = await supabase().from('events').update(p).eq('id', id).select().single(); return mapEvent(data);
  },
  async deleteEvent(id) { await supabase().from('photos').delete().eq('event_id', id); await supabase().from('events').delete().eq('id', id); },
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
  async listDownloadsByUser(userId) { const { data } = await supabase().from('downloads').select().eq('user_id', userId).order('id', { ascending: false }); return data || []; },
  async listAllDownloads() { const { data } = await supabase().from('downloads').select().order('id', { ascending: false }); return data || []; },
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
