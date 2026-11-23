'use strict';
// Lógica de la app, independiente del transporte (Vercel o servidor local).
// Cada función recibe { store, body, query, tokenUser } y devuelve { status, data }.
// La búsqueda por dorsal usa los dorsales guardados en cada foto. Esos dorsales
// se leen automáticamente al subir (visión por IA con Gemini cuando hay llave,
// si no OCR local en el teléfono) y se pueden corregir o releer después.
const crypto = require('crypto');
const { getStore } = require('./store');
const { hashPassword, verifyPassword, signToken, verifyToken, signResetToken, verifyResetToken, publicUser } = require('./auth');
const { sendResetEmail, sendSaleEmail, sendEmail } = require('./mailer');
// Clip se usa por objeto de módulo (clip.getCheckout) y no desestructurado,
// para que los tests puedan cambiar el simulado a mitad de la corrida.
const clip = require('./clip');
// Rekognition igual: por objeto de módulo (rekognition.searchFacesByImage),
// para que los tests puedan cambiar el simulado sin tocar handlers.js.
const rekognition = require('./rekognition');

function err(status, message) { const e = new Error(message); e.status = status; return e; }
function normBib(b) { return String(b == null ? '' : b).trim(); }

async function currentUser(store, token) {
  const id = verifyToken(token);
  if (!id) return null;
  return store.findUserById(id);
}
function requireUser(u) { if (!u) throw err(401, 'Inicia sesión para continuar.'); return u; }
function requirePhotographer(u) {
  requireUser(u);
  if (u.role !== 'photographer') throw err(403, 'Solo la cuenta de fotógrafo puede hacer eso.');
  // Fotógrafo nuevo pendiente: puede entrar, pero no crear eventos ni
  // vender hasta que Orlan lo apruebe. El dueño nunca está pendiente.
  if (!u.isOwner && u.approved === false) throw err(403, 'Tu cuenta de fotógrafo está pendiente de aprobación por Orlan.');
  return u;
}
function requireOwner(u) { requireUser(u); if (!u.isOwner) throw err(403, 'Solo el dueño de la página puede hacer eso.'); return u; }
// El fotógrafo dueño del evento, o Orlan (dueño de la página, ve todo).
function isEventOwner(user, ev) { return !!user && !!ev && (user.isOwner || ev.photographerId === user.id); }
// Álbum oculto: solo el dueño de la página lo ve. Para los demás el
// álbum no existe (404), sin revelar que está oculto. La columna
// is_hidden puede faltar (SQL sin correr o fila vieja): se trata como
// no oculto, nunca se rompe.
function isEventHiddenFor(user, ev) { return !!ev && !!ev.isHidden && !(user && user.isOwner); }
function assertEventVisible(user, ev) { if (isEventHiddenFor(user, ev)) throw err(404, 'Evento no encontrado.'); }

// ---- Eventos compartidos: nombre y precio POR FOTO ----
// El nombre que se muestra ("Foto de ...") es el display_name que el
// fotógrafo eligió (apodo o marca, ej. "Only Dust"); si no puso nada,
// sale su primer nombre. Nunca se inventa un nombre.
function displayNameFor(u) {
  if (!u) return '';
  const d = String(u.displayName || '').trim();
  if (d) return d;
  return String(u.name || '').trim().split(/\s+/)[0] || '';
}
// Dueño de UNA foto: quien la subió; en fotos viejas (sin
// photographer_id) es el creador del evento.
function photoOwnerId(p, ev) {
  if (p && p.photographerId != null) return Number(p.photographerId);
  return ev ? ev.photographerId : null;
}
// Precio de UNA foto en un evento de pago: el precio que SU fotógrafo
// puso al unirse al evento; si no hay fila (foto vieja o evento de un
// solo fotógrafo), el precio del evento.
async function photoPrice(store, p, ev) {
  const pid = photoOwnerId(p, ev);
  if (pid != null && ev) {
    const part = await store.getParticipant(ev.id, pid).catch(() => null);
    if (part && Number(part.priceMxn) >= 1 && Number(part.priceMxn) <= 5000) return Number(part.priceMxn);
  }
  return eventPrice(ev);
}
// ¿Puede este usuario ver/descargar esta foto gratis como fotógrafo?
// El dueño de la página sí; el fotógrafo DE LA FOTO sí; los demás
// fotógrafos son corredores como cualquier otro y deben comprar.
async function isPhotoOwner(user, p, ev) {
  if (!user) return false;
  if (user.isOwner) return true;
  return photoOwnerId(p, ev) === user.id;
}

// ---- Comisiones (decisión del dueño 2026-11-16) ----
// Todo el dinero cae en la cuenta de Clip de Orlan; él les paga a los
// fotógrafos. Por cada venta de $A: Clip se queda 4.18% (3.6% + IVA),
// Orlan se queda el 10% DE LO QUE QUEDA, y el fotógrafo el resto.
// Todo en centavos enteros para que las tres partes sumen EXACTAMENTE $A.
// $20 -> Clip $0.84, Orlan $1.92, fotógrafo $17.24.
// $50 -> Clip $2.09, Orlan $4.79, fotógrafo $43.12.
// NOTA: en un carrito Clip cobra sobre el TOTAL del carrito, no por foto;
// el reparto por foto es una aproximación (diferencia de centavos) que el
// dueño aceptó. Las descargas gratis ($0) no generan comisión ni pago.
const CLIP_FEE_RATE = 0.0418;
const ORLAN_FEE_RATE = 0.10;
const PAYOUT_DUE_HOURS = 72;
function splitSale(amount) {
  const totalCents = Math.round(Number(amount || 0) * 100);
  const clipCents = Math.round(totalCents * CLIP_FEE_RATE);
  const netCents = totalCents - clipCents;
  const orlanCents = Math.round(netCents * ORLAN_FEE_RATE);
  const photographerCents = netCents - orlanCents;
  return { amount: totalCents / 100, clipFee: clipCents / 100, orlanFee: orlanCents / 100, photographerShare: photographerCents / 100 };
}

// ---- Reparto con cupón de recompensa (2026-11-20) ----
// REGLA DURA de Orlan: el 10% sale de la comisión de OnlyClick, NUNCA
// del fotógrafo. El fotógrafo cobra EXACTAMENTE lo que cobraría sin
// descuento (splitSale sobre el precio base); la comisión de Clip se
// calcula sobre lo que el comprador REALMENTE pagó; lo que falta lo
// absorbe Orlan (su parte baja, nunca bajo cero).
// Ejemplo exacto con foto de $25 y cupón 10% (pagó $22.50):
//   splitSale(25)            -> Clip $1.04, Orlan $2.40, fotógrafo $21.56
//   splitRewardSale(22.50, 25) -> Clip $0.94, Orlan $0.00, fotógrafo $21.56
// Es EXACTAMENTE el ejemplo que Orlan calculó a mano: el fotógrafo
// cobra lo mismo con y sin cupón y Orlan se queda en $0.00.
// (Nota: 2500 × 0.0418 da 104.4999… en punto flotante, así que
// Math.round lo baja a 104 centavos: Clip cobra $1.04, no $1.05.
// Eso es lo que el código ya hacía antes de Recompensas y no se toca;
// el total siempre cuadra al centavo: Clip + Orlan + fotógrafo = pagado.)
function splitRewardSale(paidAmount, baseAmount) {
  const paidCents = Math.round(Number(paidAmount || 0) * 100);
  const baseCents = Math.round(Number(baseAmount != null ? baseAmount : paidAmount) * 100);
  const clipCents = Math.round(paidCents * CLIP_FEE_RATE);
  const photographerCents = splitSale(baseCents / 100).photographerShare * 100;
  const orlanCents = Math.max(0, paidCents - clipCents - Math.round(photographerCents));
  return { amount: paidCents / 100, clipFee: clipCents / 100, orlanFee: orlanCents / 100, photographerShare: Math.round(photographerCents) / 100 };
}

// Reparto de UNA descarga: si la venta tuvo cupón de recompensa, la
// descarga guarda baseAmount (precio sin descuento) y el reparto usa
// splitRewardSale; si no, el reparto normal. Si la venta fue SIN
// COMISIÓN (recompensa de fotógrafo, commissionFree): Orlan $0 y el
// fotógrafo se queda con lo pagado menos Clip — pero NUNCA menos que
// el reparto normal (por si un registro trajera cupón y sin-comisión
// a la vez: con cupón el fotógrafo ya recibe lo máximo que queda
// después de Clip, así que ahí el beneficio no suma nada).
function splitDownload(d) {
  const amt = Number(d.amount || 0);
  const normal = (d.baseAmount != null && Number(d.baseAmount) > amt)
    ? splitRewardSale(amt, Number(d.baseAmount))
    : splitSale(amt);
  if (!d.commissionFree) return normal;
  const paidCents = Math.round(amt * 100);
  const freeShareCents = paidCents - Math.round(normal.clipFee * 100);
  if (freeShareCents <= Math.round(normal.photographerShare * 100)) return normal;
  return { amount: amt, clipFee: normal.clipFee, orlanFee: 0, photographerShare: freeShareCents / 100 };
}

// ---- Recompensas: códigos y estrellas (2026-11-20) ----
// Base del link de referido: el dominio propio (onlyclick.com.mx).
const REFERRAL_BASE_URL = 'https://onlyclick.com.mx';
const REWARD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REWARD_CODE_PREFIX = 'RECOMP-';

function makeReferralCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += REWARD_ALPHABET[Math.floor(Math.random() * REWARD_ALPHABET.length)];
  return code;
}

function referralLink(code) { return REFERRAL_BASE_URL + '/?ref=' + String(code || '').toUpperCase(); }

// Link de referido para COMPARTIR desde una tarjeta (Orlan, 2026-11-20
// ~14:39): cada tarjeta lleva su propio parámetro `compartir` para que
// la vista previa de Facebook sea distinta — `primeros100` para la
// tarjeta de los primeros 100, `referidos` para la de invitar amigos.
// Sin kind (o kind desconocido) devuelve el link pelón de siempre
// (links viejos siguen funcionando igual). Mantener en sync con
// referralShareLink de public/app.js.
function referralShareLink(code, kind) {
  const base = referralLink(code);
  if (kind === 'primeros100' || kind === 'referidos') return base + '&compartir=' + kind;
  return base;
}

// Texto para compartir la recompensa de los primeros 100 (palabras de
// Orlan, 2026-11-20): "Obtuve una recompensa por ser de los primeros
// cien" + "tú también crea tu cuenta y obtén recompensas en tus
// primeras compras". Es el MISMO texto en el botón Compartir, en el
// botón Copiar mensaje y en la descripción Open Graph del link de
// referido. Mantener en sync con early100ShareText de public/app.js.
function early100ShareText(link) {
  return '¡Obtuve una recompensa por ser de las primeras 100 cuentas registradas en OnlyClick! 📸 Tú también crea tu cuenta y obtén recompensas en tus primeras compras. Regístrate con mi link: ' + String(link || '');
}

// Texto para compartir de la tarjeta de REFERIDOS (invitar amigos;
// palabras de Orlan, 2026-11-20 ~14:39): SOLO una invitación a la
// página para conseguir recompensas, SIN mencionar los primeros 100
// (ese texto es solo de la tarjeta de arriba). Es el MISMO texto en
// el botón Compartir, en el botón Copiar mensaje y en la descripción
// Open Graph del link con compartir=referidos. Mantener en sync con
// referralInviteShareText de public/app.js.
function referralInviteShareText(link) {
  return '¡Te invito a OnlyClick! 📸 Crea tu cuenta y obtén recompensas en tus primeras compras. Regístrate con mi link: ' + String(link || '');
}

// Texto para compartir de fotógrafos (borrador; Orlan lo revisa en su
// teléfono): invita a otros FOTÓGRAFOS a vender en OnlyClick. Es el
// MISMO texto en Compartir, en Copiar mensaje y en la vista previa
// Open Graph del link de un invitador fotógrafo. Mantener en sync con
// photographerShareText de public/app.js.
function photographerShareText(link) {
  return '¡Vendo mis fotos de carrera en OnlyClick! 📸 ¿Eres fotógrafo deportivo? Únete con mi link y vende tus fotos en tus eventos. ' + String(link || '');
}

// ---- Vista previa Open Graph del link con ?ref= (2026-11-20) ----
// Facebook no acepta texto prellenado de otras apps: cuando alguien
// comparte el link, lo que se ve es la vista previa que Facebook arma
// con las etiquetas Open Graph de la página. La vista previa depende
// del ROL del invitador y del PARÁMETRO `compartir` del link (Orlan,
// 2026-11-20 ~14:39: las dos tarjetas de atleta NO deben decir lo
// mismo):
//   - invitador fotógrafo → invitación a FOTÓGRAFOS (su texto), con
//     cualquier compartir o sin él.
//   - compartir=referidos → invitación genérica ("¡Te invito a
//     OnlyClick!"), AUNQUE el invitador sea de los primeros 100.
//   - compartir=primeros100 → primeros 100 (solo si el invitador es
//     early100; si no, la genérica de siempre).
//   - sin parámetro (links viejos) → el comportamiento de siempre:
//     early100 si el invitador es early100, si no la genérica.
// Con ref inválido o sin ref: OG por defecto. Nunca tira error: si el
// lookup falla, OG por defecto.
const OG_IMAGE_URL = REFERRAL_BASE_URL + '/icon-512.png';
const DEFAULT_OG = {
  title: 'OnlyClick — Encuentra tus fotos por dorsal',
  description: 'Busca tus fotos de carrera con tu número de dorsal o una selfie, sin revisar foto por foto. Regístrate en OnlyClick.',
  image: OG_IMAGE_URL,
  url: REFERRAL_BASE_URL + '/',
};
async function ogMetaForRef(code, storeOverride, shareKind) {
  const def = { title: DEFAULT_OG.title, description: DEFAULT_OG.description, image: DEFAULT_OG.image, url: DEFAULT_OG.url };
  try {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return def;
    const store = storeOverride || getStore();
    const inviter = await resolveReferrer(store, c);
    if (!inviter) return def;
    const kind = shareKind === 'referidos' || shareKind === 'primeros100' ? shareKind : null;
    const url = kind ? referralShareLink(c, kind) : referralLink(c);
    if (inviter.role === 'photographer') {
      return { title: '¡Vende tus fotos en OnlyClick! 📸', description: photographerShareText(url), image: OG_IMAGE_URL, url };
    }
    if (kind === 'referidos') {
      return { title: '¡Te invito a OnlyClick! 📸', description: referralInviteShareText(url), image: OG_IMAGE_URL, url };
    }
    if (await store.isEarlyAthlete(inviter.id)) {
      return { title: '¡Soy de los primeros 100 atletas en OnlyClick! 🎉', description: early100ShareText(url), image: OG_IMAGE_URL, url };
    }
    return { title: 'Te invito a OnlyClick 📸', description: 'Tus fotos de carrera con tu número de dorsal, sin revisar foto por foto. Crea tu cuenta en OnlyClick y busca tus fotos.', image: OG_IMAGE_URL, url };
  } catch (_) { return def; }
}

// Genera el código de referido del usuario si aún no tiene (perezoso:
// así cubre a los 97 que ya existen sin backfill). Nunca secuencial.
async function ensureReferralCode(store, user) {
  if (user && user.referralCode) return String(user.referralCode).toUpperCase();
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = makeReferralCode();
    if (await store.getUserByReferralCode(code)) continue;
    const updated = await store.updateUser(user.id, { referralCode: code });
    if (updated) return code;
    break;
  }
  throw err(500, 'No se pudo generar tu código de referido. Inténtalo de nuevo.');
}

// Resuelve un código de referido al invitador, o null si no vale.
// El auto-referido (el código es del mismo usuario) se ignora: el que se
// registra no puede invitarse a sí mismo.
async function resolveReferrer(store, code, excludeUserId) {
  const c = String(code || '').trim().toUpperCase();
  if (!c || c.length !== 6) return null;
  const inviter = await store.getUserByReferralCode(c);
  if (!inviter) return null;
  if (excludeUserId != null && Number(inviter.id) === Number(excludeUserId)) return null;
  return inviter;
}

// Cupón de recompensa: 10%, un solo uso, vale para CUALQUIER evento
// (eventId NULL), se genera una sola vez por usuario y por tipo.
// code: 'RECOMP-XXXXXX' con 6 caracteres aleatorios (nunca en serie).
async function generateRewardCoupon(store, userId, kind, note) {
  const existing = await store.getRewardCoupon(userId, kind);
  if (existing) return existing;
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = REWARD_CODE_PREFIX + makeReferralCode();
    if (await store.getDiscountCodeByCode(code)) continue;
    return store.createDiscountCode({ code, eventId: null, discountPercent: 10, note, createdBy: Number(userId), maxUses: 1, isReward: true, rewardKind: kind });
  }
  return null;
}

// Al llegar a 3 referidos: cupón automático + aviso de campanita.
// Se llama después de un registro con referido; si el cupón ya existe
// (o el usuario ya tenía 3+), no se duplica ni se vuelve a avisar.
async function maybeGrantReferralCoupon(store, inviterId) {
  if (!inviterId) return null;
  // Los fotógrafos tienen SUS propias recompensas (2026-11-20): el
  // cupón de 10% es para atletas que compran; un fotógrafo que invita
  // no recibe cupón de atleta (sus recompensas son ventas sin comisión).
  const inviter = await store.findUserById(inviterId).catch(() => null);
  if (inviter && inviter.role === 'photographer') return null;
  const stars = await store.countReferralsByUser(inviterId);
  if (stars < 3) return null;
  const existing = await store.getRewardCoupon(inviterId, 'referral');
  if (existing) return existing;
  const coupon = await generateRewardCoupon(store, inviterId, 'referral', 'Cupón por invitar a 3 amigos');
  if (!coupon) return null;
  try { await store.createAnnouncement({ authorId: Number(inviterId), userId: Number(inviterId), title: '¡Ganaste 10% de descuento!', body: 'Invitaste a 3 amigos a OnlyClick. Ya tienes tu cupón de 10% en tu próxima compra. Míralo en Recompensas.', kind: 'reward' }); } catch (_) {}
  return coupon;
}

// Cupón de agradecimiento a los primeros 100 atletas: se genera la
// primera vez que el atleta abre Recompensas (y solo si está entre los
// primeros 100 por orden de registro). Al crearse, también le llega
// su aviso de campanita (ver ensureEarly100Notice).
async function maybeGrantEarlyCoupon(store, user) {
  if (!user || user.role !== 'athlete') return null;
  if (await store.getRewardCoupon(user.id, 'early100')) return null;
  if (!await store.isEarlyAthlete(user.id)) return null;
  const coupon = await generateRewardCoupon(store, user.id, 'early100', 'Gracias por ser de los primeros 100 atletas');
  if (!coupon) return null;
  await ensureEarly100Notice(store, user);
  return coupon;
}

// Aviso de campanita para los primeros 100 atletas (Orlan, 2026-11-20):
// les dice que tienen su cupón de 10% y que lo reclamen en
// Mi cuenta → Recompensas. El código del cupón NO va en el aviso.
// Se crea UNA sola vez por atleta y se identifica por su título y el
// usuario. Cubre los dos casos: (a) cupón recién generado, y (b) cupón
// que ya existía sin aviso (se generó abriendo Recompensas antes de
// que existiera el aviso) — Orlan lo pidió para los que YA tienen el
// cupón, no solo para los que lo generen de aquí en adelante.
const EARLY100_NOTIF_TITLE = '¡Eres de los primeros 100!';
const EARLY100_NOTIF_BODY = '🎉 Gracias por ser parte de OnlyClick desde el inicio. Tienes 10% de descuento en tu próxima compra. Entra a Mi cuenta → Recompensas y reclama tu cupón.';
async function ensureEarly100Notice(store, user) {
  if (!user || user.role !== 'athlete') return false;
  if (!await store.getRewardCoupon(user.id, 'early100')) return false;
  const all = await store.listAnnouncements();
  if ((all || []).some(a => Number(a.userId) === Number(user.id) && String(a.title || '') === EARLY100_NOTIF_TITLE)) return false;
  try { await store.createAnnouncement({ authorId: Number(user.id), userId: Number(user.id), title: EARLY100_NOTIF_TITLE, body: EARLY100_NOTIF_BODY, kind: 'reward' }); } catch (_) { return false; }
  return true;
}

// Revisión ligera al cargar la app (una vez por sesión, solo atletas
// con sesión): asegura el cupón de agradecimiento de los primeros 100
// y su aviso de campanita aunque el atleta nunca abra Recompensas.
// Idempotente y barata; nunca rompe la carga. Los fotógrafos también
// pasan por aquí: les otorga las ventas sin comisión que ya se ganaron.
async function rewardsCheck(store, user) {
  if (!user) return { status: 200, data: { ok: true, early: false } };
  if (user.role === 'photographer') {
    const state = await maybeGrantPhotographerRewards(store, user.id).catch(() => null);
    return { status: 200, data: { ok: true, early: false, photographer: true, freeSalesBank: state ? state.bank : Number(user.freeSalesBank || 0) } };
  }
  if (user.role !== 'athlete') return { status: 200, data: { ok: true, early: false } };
  const coupon = await maybeGrantEarlyCoupon(store, user);
  if (coupon) return { status: 200, data: { ok: true, early: true } };
  await ensureEarly100Notice(store, user);
  return { status: 200, data: { ok: true, early: await store.isEarlyAthlete(user.id) } };
}

// ---- Recompensas para FOTÓGRAFOS (Orlan, 2026-11-20 ~14:24) ----
// Los fotógrafos VENDEN, no compran: el cupón de 10% y lo de los 3
// amigos no les sirve. Sus recompensas son VENTAS SIN COMISIÓN, dos
// formas de ganarlas, cada una da +2 (ni 5 ni 10):
//   A) REFERIR FOTÓGRAFOS: cada 3 fotógrafos invitados que hacen su
//      primera venta pagada = +2. Repetible.
//   B) HITOS DE VENTAS: cada 50 fotos vendidas = +2. Repetible
//      (50, 100, 150...).
// "Venta sin comisión" = la comisión de OnlyClick (10% después de
// Clip) es $0 en esa venta: el fotógrafo se queda con lo pagado menos
// Clip; Orlan $0. El banco se descuenta al CONFIRMARSE el pago (no
// al pagarle al fotógrafo) y la venta queda marcada commissionFree en
// la descarga y en el pago, para que el reparto la lea.
// Los bloques ya otorgados se guardan en el usuario (así el otorgar
// es idempotente: abrir Recompensas 10 veces no regala 10 veces).
const PHOTOG_REWARD_MILESTONE = 50;
const PHOTOG_REWARD_PER_BLOCK = 2;
const PHOTOG_REWARD_REFERRAL_STARS = 3;

// Otorga las ventas sin comisión que el fotógrafo ya se ganó (si hay
// bloques nuevos) y devuelve su estado actual. Se llama al abrir
// Recompensas y al confirmarse una venta. Idempotente: si no hay
// bloques nuevos, no regala nada ni vuelve a avisar. Nunca rompe
// nada: si el SQL nuevo no se ha corrido, el banco no se guarda y se
// devuelve el estado guardado.
async function maybeGrantPhotographerRewards(store, photographerId) {
  const user = await store.findUserById(photographerId).catch(() => null);
  if (!user || user.role !== 'photographer') return null;
  const referred = (await tryStore(store, 'listReferredPhotographersWithSale', photographerId)) || [];
  const stars = referred.filter(r => r.hasSold).length;
  const soldCount = (await tryStore(store, 'countPaidSalesByPhotographer', photographerId)) || 0;
  const wantRefBlocks = Math.floor(stars / PHOTOG_REWARD_REFERRAL_STARS);
  const wantMsBlocks = Math.floor(soldCount / PHOTOG_REWARD_MILESTONE);
  const haveRefBlocks = Number(user.freeSalesReferralBlocks || 0);
  const haveMsBlocks = Number(user.freeSalesMilestoneBlocks || 0);
  const newRefBlocks = Math.max(0, wantRefBlocks - haveRefBlocks);
  const newMsBlocks = Math.max(0, wantMsBlocks - haveMsBlocks);
  const grantedNow = (newRefBlocks + newMsBlocks) * PHOTOG_REWARD_PER_BLOCK;
  let bank = Number(user.freeSalesBank || 0);
  if (grantedNow > 0) {
    bank += grantedNow;
    try {
      await store.updateUser(photographerId, { freeSalesBank: bank, freeSalesReferralBlocks: wantRefBlocks, freeSalesMilestoneBlocks: wantMsBlocks });
    } catch (_) {
      // SQL sin correr: no se guarda nada y no se avisa; en la próxima
      // lectura se vuelve a intentar. Se devuelve el estado guardado.
      return { bank: Number(user.freeSalesBank || 0), referralStars: stars, referralBlocks: haveRefBlocks, referred, soldCount, milestoneBlocks: haveMsBlocks, grantedNow: 0 };
    }
    if (newRefBlocks > 0) {
      try { await store.createAnnouncement({ authorId: Number(photographerId), userId: Number(photographerId), title: '¡Ganaste ventas sin comisión! 🎉', body: 'Invitaste a ' + stars + ' fotógrafos que ya vendieron su primera foto. Tienes ' + (newRefBlocks * PHOTOG_REWARD_PER_BLOCK) + ' ventas sin comisión: en esas ventas la comisión de OnlyClick es $0.', kind: 'reward' }); } catch (_) {}
    }
    if (newMsBlocks > 0) {
      try { await store.createAnnouncement({ authorId: Number(photographerId), userId: Number(photographerId), title: '¡Llegaste a ' + (wantMsBlocks * PHOTOG_REWARD_MILESTONE) + ' fotos vendidas! 🎉', body: 'Ya vendiste ' + soldCount + ' fotos en OnlyClick. Tienes ' + (newMsBlocks * PHOTOG_REWARD_PER_BLOCK) + ' ventas sin comisión: en esas ventas la comisión de OnlyClick es $0.', kind: 'reward' }); } catch (_) {}
    }
  }
  return { bank, referralStars: stars, referralBlocks: wantRefBlocks, referred, soldCount, milestoneBlocks: wantMsBlocks, grantedNow };
}

// ¿Esta venta es sin comisión? Solo si: el fotógrafo tiene banco, la
// venta es de precio completo (SIN cupón de recompensa) y la venta le
// dejaría comisión a Orlan. Con cupón de recompensa el fotógrafo ya
// recibe lo máximo que queda después de Clip (el reparto de recompensa
// le paga sobre el precio base), así que ahí no hay extra que dar y el
// banco NO se gasta. Con un código normal (20%) el fotógrafo NO está
// protegido (cobra sobre lo pagado), así que ahí el banco SÍ da extra
// y sí se gasta. El banco se descuenta aquí, al confirmarse el pago;
// si ya se gastó, no se vuelve a gastar (la descarga guarda la marca).
async function maybeApplyFreeSale(store, payment) {
  const amt = Number(payment.amount || 0);
  if (!amt) return false;
  // Cupón de recompensa (baseAmount guardado): el fotógrafo ya cobra
  // sobre el precio sin descuento; no hay extra que dar.
  if (payment.baseAmount != null && Number(payment.baseAmount) > amt) return false;
  if (!(splitSale(amt).orlanFee > 0)) return false;
  let photographerId = null;
  try {
    const photo = await store.getPhoto(payment.photoId);
    const ev = photo ? await store.getEvent(photo.eventId || payment.eventId) : null;
    photographerId = photoOwnerId(photo, ev);
  } catch (_) { return false; }
  if (photographerId == null) return false;
  return !!(await tryStore(store, 'consumeFreeSale', photographerId));
}

// Vista de Recompensas del usuario: link, estrellas, referidos y cupones.
// POR ROL: el atleta ve lo de siempre (referidos + primeros 100); el
// fotógrafo ve SU pantalla (referir fotógrafos + hitos + banco de
// ventas sin comisión) y NUNCA el cupón de 10% ni la tarjeta de los
// primeros 100.
async function getRewards(store, user) {
  const referralCode = await ensureReferralCode(store, user);
  if (user.role === 'photographer') {
    const state = await maybeGrantPhotographerRewards(store, user.id).catch(() => null);
    const referred = (state && state.referred) || [];
    return {
      role: 'photographer',
      referralCode,
      referralLink: referralLink(referralCode),
      photographerStars: state ? state.referralStars : 0,
      photographerStarsNeeded: PHOTOG_REWARD_REFERRAL_STARS,
      referredPhotographers: referred.map(r => ({ name: r.name, hasSold: !!r.hasSold })),
      freeSalesBank: state ? state.bank : Number(user.freeSalesBank || 0),
      soldCount: state ? state.soldCount : 0,
      milestoneSize: PHOTOG_REWARD_MILESTONE,
      milestoneBlocks: state ? state.milestoneBlocks : 0,
      stars: 0, starsNeeded: 3, referred: [], referralCoupon: null,
      earlyAthlete: false, earlyCoupon: null,
    };
  }
  const [stars, referred, referralCoupon, earlyAthlete] = await Promise.all([
    store.countReferralsByUser(user.id),
    store.listReferredUsers(user.id),
    store.getRewardCoupon(user.id, 'referral'),
    store.isEarlyAthlete(user.id),
  ]);
  let earlyCoupon = null;
  if (earlyAthlete) {
    earlyCoupon = await maybeGrantEarlyCoupon(store, user);
    if (!earlyCoupon) earlyCoupon = await store.getRewardCoupon(user.id, 'early100');
  }
  return {
    role: 'athlete',
    referralCode,
    referralLink: referralLink(referralCode),
    stars,
    starsNeeded: 3,
    referred: (referred || []).map(r => ({ name: r.name })),
    referralCoupon: referralCoupon ? publicDiscountCode(referralCoupon) : null,
    earlyAthlete: !!earlyAthlete,
    earlyCoupon: earlyCoupon ? publicDiscountCode(earlyCoupon) : null,
  };
}

// Endpoint público: ¿quién invitó con este código? Solo el nombre
// visible, sin datos sensibles. Sin sesión: el registro muestra
// "Te invitó [nombre]". También devuelve el rol del invitador para
// que el banner no prometa una estrella cuando el invitador es
// fotógrafo (ahí la estrella solo llega con la primera venta del
// referido, no con el registro).
async function referralInfo(store, code) {
  const inviter = await store.getUserByReferralCode(String(code || '').trim().toUpperCase());
  if (!inviter) return { valid: false, inviterName: null, inviterRole: null };
  return { valid: true, inviterName: displayNameFor(inviter) || String(inviter.name || '').trim().split(/\s+/)[0] || 'Un amigo', inviterRole: inviter.role || null };
}

async function register(store, body) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = body.role === 'photographer' ? 'photographer' : 'athlete';
  if (!name || !email.includes('@') || password.length < 6) throw err(400, 'Faltan datos: nombre, correo válido y contraseña de al menos 6 caracteres.');
  if (await store.findUserByEmail(email)) throw err(400, 'Ese correo ya tiene cuenta. Inicia sesión.');
  // Registro con link de invitación: solo para fotógrafos. El link se
  // valida ANTES de crear la cuenta; si no vale, no se crea nada.
  let inviteApp = null;
  const inviteToken = String(body.inviteToken || '').trim();
  if (role === 'photographer' && inviteToken) {
    inviteApp = await store.getApplicationByToken(inviteToken);
    if (!inviteIsValid(inviteApp)) throw err(400, 'El link de invitación no es válido, ya venció o ya fue usado. Pide uno nuevo o llena el formulario de fotógrafo en el inicio.');
  }
  // Varios fotógrafos: cualquiera puede registrarse como fotógrafo, pero
  // entra PENDIENTE (approved=false) hasta que Orlan lo apruebe, SALVO
  // que venga con un link de invitación válido: ahí entra aprobado y
  // su cuenta queda ligada a su solicitud. Los deportistas no necesitan
  // aprobación.
  const approved = role === 'photographer' ? !!inviteApp : true;
  // Recompensas: ¿viene con link de referido (?ref=CODIGO)? Código
  // inválido o auto-referido se ignora y se registra normal. El referido
  // se fija UNA sola vez, al crear la cuenta.
  let referredBy = null;
  try {
    const inviter = await resolveReferrer(store, body.referralCode);
    if (inviter) referredBy = Number(inviter.id);
  } catch (_) { referredBy = null; }
  const user = await store.createUser({ name, email, passwordHash: hashPassword(password), role, approved, isOwner: false, payoutClabe: '', referredBy });
  if (inviteApp) {
    // Si otro registro ganó la carrera y ya ligó el link, la cuenta
    // recién creada vuelve a pendiente (Orlan la puede aprobar a mano).
    const linked = await store.linkApplication(inviteToken, user.id);
    if (!linked) await store.updateUser(user.id, { approved: false });
  }
  // Si vino referido, el invitador suma una estrella; a las 3 se le
  // genera el cupón automáticamente. Si esto falla, el registro ya
  // quedó hecho: el referido se guardó en la cuenta.
  if (referredBy) { try { await maybeGrantReferralCoupon(store, referredBy); } catch (_) {} }
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

// Fecha en que caduca un álbum: fecha del evento + 60 días. Sin fecha
// válida no caduca.
function eventExpiresAt(ev) {
  const t = ev && ev.eventDate ? new Date(String(ev.eventDate)).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t + EVENT_EXPIRY_DAYS * 24 * 3600 * 1000).toISOString();
}
function daysUntil(dateIso) {
  if (!dateIso) return null;
  return Math.ceil((new Date(dateIso).getTime() - Date.now()) / (24 * 3600 * 1000));
}
// Panel rápido 2026-11-19 (D22): llama un método NUEVO del store si
// existe; si no existe (stores viejos o simulados de los tests) o falla,
// devuelve null para que el llamador use la ruta vieja (una por una).
// El resultado es el mismo, solo más lento: nunca se rompe nada.
async function tryStore(store, name, ...args) {
  try {
    if (store && typeof store[name] === 'function') return await store[name](...args);
  } catch (_) {}
  return null;
}
// Borra los álbumes ya caducados (fotos, archivos y portada). Se corre al
// listar eventos, al abrir uno y al listar Mis fotos / notificaciones:
// la primera visita después de la fecha dispara la limpieza. Un fallo al
// borrar un álbum no rompe la lista.
// Panel rápido 2026-11-19 (D22): ANTES cada llamada listaba TODOS los
// eventos con su conteo de fotos (1 + N consultas) solo para ver si
// alguno caducó. AHORA pide solo los ids ya caducados con UNA consulta
// por fecha; si el store no tiene ese método, cae al escaneo de antes.
async function expireOldEvents(store) {
  const cutoff = new Date(Date.now() - EVENT_EXPIRY_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const ids = await tryStore(store, 'listExpiredEventIds', cutoff);
  if (ids) {
    for (const id of ids) {
      try {
        await store.deleteEvent(id);
        // Fase 2: al caducar el álbum se borra también su colección de
        // caras en Rekognition (mejor esfuerzo: si falla, no rompe nada).
        try { await rekognition.deleteCollection(rekognition.collectionIdFor(id)); } catch (_) {}
      } catch (_) {}
    }
    return;
  }
  const now = Date.now();
  for (const e of await store.listEvents()) {
    const exp = eventExpiresAt(e);
    if (exp && new Date(exp).getTime() <= now) {
      try {
        await store.deleteEvent(e.id);
        // Fase 2: al caducar el álbum se borra también su colección de
        // caras en Rekognition (mejor esfuerzo: si falla, no rompe nada).
        try { await rekognition.deleteCollection(rekognition.collectionIdFor(e.id)); } catch (_) {}
      } catch (_) {}
    }
  }
}
// Álbumes del usuario que caducan en 15 días o menos: los que creó, en
// los que participa o de los que descargó fotos. Ordenados por días.
async function expiringEventsFor(store, user) {
  const events = await store.listEvents();
  const downloads = await store.listDownloadsByUser(user.id);
  const myEventIds = new Set(downloads.map(d => d.eventId));
  const joined = new Set(await store.listJoinedEventIds(user.id).catch(() => []));
  const out = [];
  for (const e of events) {
    const mine = e.photographerId === user.id || joined.has(e.id) || myEventIds.has(e.id);
    if (!mine) continue;
    const exp = eventExpiresAt(e);
    if (!exp) continue;
    const days = daysUntil(exp);
    if (days == null || days <= 0 || days > EXPIRY_WARN_DAYS) continue;
    out.push({ eventId: e.id, eventName: e.name, daysLeft: days, expiresAt: exp, warnFrom: new Date(new Date(exp).getTime() - EXPIRY_WARN_DAYS * 24 * 3600 * 1000).getTime() });
  }
  out.sort((a, b) => a.daysLeft - b.daysLeft);
  return out;
}

async function listEvents(store, user) {
  await expireOldEvents(store);
  const events = await store.listEvents();
  // Nombre del fotógrafo de cada evento (se muestra en la tarjeta y en
  // el detalle: "Fotos de <nombre>"). La búsqueda y el inicio son
  // globales: se ven los eventos de todos los fotógrafos.
  const names = new Map();
  const ownerIds = new Set();
  for (const ph of await store.listPhotographers()) { names.set(ph.id, displayNameFor(ph)); if (ph.isOwner) ownerIds.add(ph.id); }
  // Las filas de participantes de cada evento son independientes: se
  // piden TODAS en una sola consulta (antes iban una por una y la lista
  // tardaba); si el store no tiene el método nuevo, una por una como antes.
  let partsByEvent = null;
  const allParts = await tryStore(store, 'listAllParticipants');
  if (allParts) {
    partsByEvent = new Map();
    for (const pt of allParts) {
      const list = partsByEvent.get(pt.eventId) || [];
      list.push(pt);
      partsByEvent.set(pt.eventId, list);
    }
  }
  const partsList = partsByEvent
    ? events.map(e => partsByEvent.get(e.id) || [])
    : await Promise.all(events.map(e => store.listParticipants(e.id).catch(() => [])));
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const parts = partsList[i] || [];
    const myPart = user ? parts.find(pt => Number(pt.photographerId) === user.id) : null;
    const isCreator = user ? e.photographerId === user.id : false;
    out.push({
      ...e,
      expiresAt: eventExpiresAt(e),
      photographerName: names.get(e.photographerId) || '',
      // Sin filas (tabla aún sin correr el SQL): el creador es el único
      // participante y el evento no es compartido.
      participantsCount: Math.max(parts.length, 1),
      isShared: parts.length > 1,
      // Evento oficial: lo creó el dueño (OnlyClick). Los eventos de otros
      // fotógrafos no llevan la insignia.
      isOfficial: ownerIds.has(e.photographerId),
      joined: isCreator || !!myPart,
      myPrice: myPart ? Number(myPart.priceMxn) : (isCreator ? eventPrice(e) : undefined),
    });
  }
  // Por si el borrado de un caducado falló, que no salga en la lista.
  // Álbum oculto: solo lo ve el dueño (en sus listas sale con la
  // etiqueta "Oculto"); para los demás no existe. Si el dueño oculta
  // un evento compartido que él creó, los participantes tampoco lo ven.
  return { status: 200, data: { events: out.filter(e => (!e.isHidden || (user && user.isOwner)) && (!e.expiresAt || new Date(e.expiresAt).getTime() > Date.now())) } };
}

async function createEvent(store, user, body) {
  requirePhotographer(user);
  const name = String(body.name || '').trim();
  if (!name) throw err(400, 'El evento necesita un nombre.');
  // Álbum exclusivo OnlyClick: SOLO el dueño puede marcarlo (otros
  // fotógrafos ni siquiera ven la casilla; si la mandan a mano se ignora).
  // Un álbum exclusivo siempre es GRATIS y sin precio: el organizador le
  // paga directo al dueño, fuera de OnlyClick.
  const isExclusive = user.isOwner && body.isExclusive === true;
  // Álbum "Próximo evento": SOLO el dueño puede marcarlo (mismo patrón
  // que el exclusivo: si otro fotógrafo lo manda a mano, se ignora).
  // Se publica la portada, el título y la fecha con la etiqueta
  // "Próximo evento", sin precio y sin abrirse; cuando suba las fotos el
  // dueño lo quita en Gestión (set-event-upcoming) y el álbum se vuelve
  // normal. La caducidad de 60 días sigue contando desde la fecha del
  // evento, igual que siempre.
  const isUpcoming = user.isOwner && body.isUpcoming === true;
  const pm = Number(body.priceMxn);
  const ev = await store.createEvent({
    photographerId: user.id, name, sport: String(body.sport || 'Carrera'),
    eventDate: String(body.eventDate || ''), location: String(body.location || ''),
    freeMode: isExclusive ? true : body.freeMode !== false,
    priceMxn: isExclusive ? 0 : ((Number.isFinite(pm) && pm >= 1 && pm <= 5000) ? pm : 20),
    isExclusive, isUpcoming,
  });
  // El creador ya es participante de su evento, con el precio del evento.
  try { await store.joinEvent(ev.id, user.id, ev.priceMxn); } catch (_) {}
  return { status: 201, data: { event: ev } };
}

async function getEvent(store, user, eventId, query) {
  await expireOldEvents(store);
  const ev = await store.getEvent(eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  // Álbum caducado: se borra y ya no se puede abrir.
  const exp = eventExpiresAt(ev);
  if (exp && new Date(exp).getTime() <= Date.now()) {
    try { await store.deleteEvent(ev.id); } catch (_) {}
    throw err(404, 'Este álbum ya caducó.');
  }
  // Álbum oculto: solo el dueño lo puede abrir (también por link directo).
  assertEventVisible(user, ev);
  // Álbum "Próximo evento": solo el dueño lo puede abrir (para subir
  // fotos y gestionarlo); para los demás no se abre todavía.
  if (ev.isUpcoming && !(user && user.isOwner)) throw err(404, 'Este álbum aún no tiene fotos. Las fotos estarán disponibles después de la carrera.');
  // Cinco lecturas independientes: a la vez (antes iban una tras otra y
  // abrir la galería tardaba).
  const [photos, userDownloads, photographer, parts, allPhotographers] = await Promise.all([
    store.listPhotos(eventId),
    user ? store.listDownloadsByUser(user.id) : Promise.resolve([]),
    store.findUserById(ev.photographerId),
    store.listParticipants(eventId).catch(() => []),
    store.listPhotographers(),
  ]);
  const owned = new Set();
  for (const d of userDownloads || []) owned.add(d.photoId);
  const users = new Map((allPhotographers || []).map(u => [u.id, u]));
  // Cada foto lleva su autor, su precio y la propina DE SU fotógrafo.
  const enriched = photos.map(p => {
    const pid = photoOwnerId(p, ev);
    const u = pid != null ? users.get(pid) : null;
    const part = pid != null ? parts.find(pt => Number(pt.photographerId) === pid) : null;
    return {
      ...p, photographerId: pid, photographerName: displayNameFor(u),
      priceMxn: part ? Number(part.priceMxn) : eventPrice(ev),
      tipClabe: u ? (u.tipClabe || '') : '', tipName: displayNameFor(u),
      owned: owned.has(p.id), filePath: undefined, storagePath: undefined, thumbPath: undefined,
    };
  });
  const partRows = parts.length ? parts : [{ photographerId: ev.photographerId, priceMxn: ev.priceMxn, joinedAt: ev.createdAt }];
  // Paginación opcional (el álbum pide de 60 en 60, Orlan 2026-11-22):
  // con limit/offset se devuelve solo esa página y totalPhotos con el
  // total del álbum. Sin ellos se devuelven todas, como antes (la
  // lectura de dorsales y Revisar dorsales las necesitan completas).
  const qLimit = query ? Number(query.limit) : NaN;
  const qOffset = query ? Number(query.offset) : NaN;
  const limit = Number.isFinite(qLimit) && qLimit > 0 ? Math.min(Math.floor(qLimit), 200) : null;
  const offset = Number.isFinite(qOffset) && qOffset >= 0 ? Math.floor(qOffset) : 0;
  const page = limit == null ? enriched : enriched.slice(offset, offset + limit);
  const myPart = user ? parts.find(pt => Number(pt.photographerId) === user.id) : null;
  const isCreator = user ? ev.photographerId === user.id : false;
  return { status: 200, data: {
    event: ev,
    photographerName: photographer ? displayNameFor(photographer) : '',
    photos: page,
    totalPhotos: enriched.length,
    tipClabe: photographer ? (photographer.tipClabe || '') : '',
    tipName: photographer ? displayNameFor(photographer) : '',
    participants: partRows.map(pt => {
      const u = users.get(Number(pt.photographerId));
      return { photographerId: Number(pt.photographerId), displayName: displayNameFor(u), photoCount: photos.filter(p => photoOwnerId(p, ev) === Number(pt.photographerId)).length, priceMxn: Number(pt.priceMxn) };
    }),
    isShared: parts.length > 1,
    isOfficial: photographer ? !!photographer.isOwner : false,
    isParticipant: isCreator || !!myPart,
    myPrice: myPart ? Number(myPart.priceMxn) : (isCreator ? eventPrice(ev) : null),
  } };
}

async function uploadPhoto(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(body.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  // Subir a un evento compartido: el creador o cualquier participante.
  const part = ev.photographerId !== user.id ? await store.getParticipant(ev.id, user.id).catch(() => null) : null;
  if (ev.photographerId !== user.id && !part) throw err(403, 'No participas en ese evento. Únete primero desde el evento.');
  // Álbum exclusivo OnlyClick: SOLO el creador (dueño) sube fotos; ni
  // siquiera un participante (que no puede haber: nadie se puede unir).
  if (ev.isExclusive && ev.photographerId !== user.id) throw err(403, 'Este álbum es exclusivo OnlyClick: solo el dueño sube fotos.');
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
  // La foto queda a nombre de QUIEN LA SUBE (de la sesión, nunca de lo
  // que mande el cliente): así cada quien cobra sus fotos en el evento.
  // Metadatos de la foto (resolución y tamaño): los manda el cliente al
  // subir, para la vista ampliada. Si no vienen, la vista ampliada los
  // calcula sola la primera vez (/api/photo-meta).
  const widthPx = Number(body.widthPx) || null;
  const heightPx = Number(body.heightPx) || null;
  const sizeKb = Number(body.sizeKb) || null;
  // ¿Es la PRIMERA foto del evento? Si sí, hay atletas esperando el
  // aviso "Avísame cuando haya fotos": se les avisa una sola vez.
  const hadPhotos = (await store.listPhotos(ev.id).catch(() => [])).length > 0;
  const photo = await store.createPhoto({ eventId: ev.id, filename: String(body.filename || 'foto.jpg'), mimeType, bibs, price: ev.isExclusive ? 0 : Number(body.price || 0), photographerId: user.id, fileBuffer, thumbBuffer, widthPx, heightPx, sizeKb });
  if (!hadPhotos) { try { await notifyPhotoAlerts(store, ev.id); } catch (_) { /* el aviso nunca rompe la subida */ } }
  return { status: 201, data: { photo: { ...photo, filePath: undefined, storagePath: undefined, thumbPath: undefined } } };
}

// ---- Miniaturas de galería para fotos viejas (backfill) ----
// Las fotos subidas antes del 2026-11-15 no tienen miniatura: la galería
// pide /api/photo?thumb=1 y el servidor cae a la foto completa (~300 KB),
// y eso es lo que se comió la cuota de egress de Supabase (5.93/5 GB en
// el ciclo 12 nov-12 dic 2026; gracia hasta el 17 dic, luego 402).
// Este endpoint (SOLO el dueño) genera la miniatura de 400px (~30-50 KB)
// de las fotos que aún no tienen, en lotes pequeños para no pasar el
// límite de 10 s de Vercel. Idempotente y reanudable: salta las fotos que
// ya tienen miniatura y devuelve nextCursor para seguir; si se cierra la
// página, lo ya guardado queda y al darle otra vez continúa.
// El original NUNCA se toca: la vista ampliada, la descarga y la compra
// siguen usando la foto completa; la marca de agua no cambia.
const BACKFILL_BATCH_DEFAULT = 6;
const BACKFILL_BATCH_MAX = 10;

async function backfillThumbs(store, user, body) {
  requireOwner(user);
  const { makeThumb, thumbsAvailable } = require('./thumbs');
  if (!thumbsAvailable()) throw err(500, 'Falta jpeg-js en el servidor para generar miniaturas.');
  const hasEventId = body.eventId != null && body.eventId !== '';
  const eventId = hasEventId ? Number(body.eventId) : null;
  if (hasEventId && !Number.isFinite(eventId)) throw err(400, 'eventId no válido.');
  const limit = Math.min(BACKFILL_BATCH_MAX, Math.max(1, Number(body.limit) || BACKFILL_BATCH_DEFAULT));
  const cursor = Number(body.cursor) || 0; // último id procesado (exclusivo)
  let photos;
  if (eventId != null) {
    const ev = await store.getEvent(eventId);
    if (!ev) throw err(404, 'Evento no encontrado.');
    photos = await store.listPhotos(eventId);
  } else {
    const events = await store.listEvents();
    photos = [];
    for (const ev of events) photos.push(...(await store.listPhotos(ev.id)));
  }
  // Solo las que aún no tienen miniatura, en orden de id, después del cursor.
  const missing = photos.filter(p => !p.thumbPath).sort((a, b) => a.id - b.id).filter(p => p.id > cursor);
  const totalMissing = missing.length;
  const batch = missing.slice(0, limit);
  const created = [];
  const skipped = [];
  const failed = [];
  await Promise.all(batch.map(async (p) => {
    try {
      const mime = String(p.mimeType || '');
      if (mime.toLowerCase() !== 'image/jpeg' && mime.toLowerCase() !== 'image/jpg') { skipped.push({ id: p.id, reason: 'no-jpeg' }); return; }
      const bytes = await store.readPhotoBytes(p);
      const thumb = makeThumb(bytes, mime);
      if (!thumb) { skipped.push({ id: p.id, reason: 'sin-miniatura' }); return; }
      const thumbPath = await store.saveThumbBuffer(p.id, thumb.buffer);
      await store.setPhotoThumb(p.id, thumbPath);
      created.push(p.id);
    } catch (e) {
      failed.push({ id: p.id, reason: e && e.message ? String(e.message).slice(0, 120) : 'error' });
    }
  }));
  const lastId = batch.length ? batch[batch.length - 1].id : cursor;
  const remaining = Math.max(0, totalMissing - batch.length);
  return { status: 200, data: { ok: true, eventId, processed: batch.length, created: created.length, skipped: skipped.length, failed, nextCursor: remaining > 0 ? lastId : null, done: remaining === 0, remaining } };
}

// ---- "Avísame cuando haya fotos" + metadatos + carrito compartido ----
// Ideas de ZebraSnap (aprobadas por Orlan 2026-11-17): en eventos SIN
// fotos todavía, el atleta deja su correo y recibe UN aviso cuando el
// fotógrafo sube las primeras fotos. La vista ampliada muestra
// resolución y tamaño. El carrito y una foto se pueden compartir por
// link (WhatsApp) para que otra persona los vea y compre.

// POST /api/subscribe-photo-alert { eventId, email } — público, sin
// sesión. Si el evento YA tiene fotos, no se guarda nada: se devuelve
// hasPhotos para que el frontend le diga al atleta que ya puede buscar.
// Un correo por evento (la base lo deduplica); si la tabla aún no
// existe en vivo (falta correr sql/zebrasnap-ideas.sql), se avisa con
// 503 en vez de romper.
async function subscribePhotoAlert(store, user, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const eventId = Number(body.eventId);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400, 'Escribe un correo válido.');
  if (!eventId) throw err(400, 'Falta el evento.');
  const ev = await store.getEvent(eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  // No se deja suscribir (ni se revela si tiene fotos) a un álbum oculto.
  assertEventVisible(user, ev);
  const count = (await store.listPhotos(eventId).catch(() => [])).length;
  if (count > 0) return { status: 200, data: { ok: true, hasPhotos: true, eventId } };
  let sub;
  try { sub = await store.createPhotoAlert({ eventId, email }); }
  catch (e) {
    if (/photo_alerts/i.test(e.message || '')) throw err(503, 'El aviso por correo aún no está activado.');
    throw e;
  }
  return { status: 200, data: { ok: true, hasPhotos: false, eventId, already: !!sub.already } };
}

// Aviso a los atletas que dejaron su correo en un evento sin fotos.
// Se llama desde uploadPhoto cuando llega la PRIMERA foto del evento.
// Primero se marcan como avisados (reclamar) y luego se manda el correo:
// si dos subidas llegan juntas, solo una avisa. Los correos van en
// paralelo con un tope total de 4 s (igual que los avisos de venta); si
// el correo falla, no se reintenta y la subida no se rompe. Nunca se
// avisa a Orlan: solo a los correos que lo pidieron.
async function notifyPhotoAlerts(store, eventId) {
  let pending;
  try { pending = await store.listPendingAlerts(eventId); } catch (_) { return; }
  if (!pending.length) return;
  const ids = pending.map(a => a.id);
  try { await store.markAlertsNotified(ids); } catch (_) { return; }
  const ev = await store.getEvent(eventId).catch(() => null);
  const base = publicBase();
  const eventName = ev ? ev.name : 'tu evento';
  await Promise.race([
    Promise.allSettled(pending.map(a => sendEmail({
      to: a.email,
      subject: `¡Ya hay fotos de ${eventName} en OnlyClick!`,
      text: `Hola,\n\n¡Ya publicaron fotos de ${eventName} en OnlyClick! Búscalas por tu dorsal o tu selfie aquí:\n${base}/?event=${eventId}\n\nSi no sales en las fotos, es que el fotógrafo todavía está subiendo más. Vuelve a revisar en un rato.`,
    }))),
    new Promise(r => setTimeout(r, 4000)),
  ]).catch(() => {});
}

// Resolución y tamaño de una foto, sin decodificarla entera: lee solo la
// cabecera (JPEG: marcador SOF; PNG: IHDR; GIF: cabecera). Devuelve null
// si no se puede leer (p. ej. WebP).
function imageDimensions(buf, mimeType) {
  try {
    if (!buf || buf.length < 10) return null;
    const m = String(mimeType || '').toLowerCase();
    if (m === 'image/png' && buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (m === 'image/gif' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // JPEG: SOI (FFD8) y luego marcadores; SOF0/1/2 traen alto y ancho.
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let off = 2;
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xFF) return null;
      const code = buf[off + 1];
      if (code === 0xD8 || code === 0x01 || (code >= 0xD0 && code <= 0xD7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (code === 0xC0 || code === 0xC1 || code === 0xC2) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
    return null;
  } catch (_) { return null; }
}

// GET /api/photo-meta?id=... — público (solo metadatos, nada sensible).
// Devuelve nombre de archivo, resolución y tamaño en KB. Si la foto no
// trae los datos guardados (fotos viejas), se calculan leyendo la foto
// UNA vez y se guardan para no volver a leerla. Si no se pueden
// calcular, se devuelven en null y la vista ampliada muestra "—".
async function photoMeta(store, query) {
  const id = Number((query && query.id) || 0);
  if (!id) throw err(400, 'Falta la foto.');
  const photo = await store.getPhoto(id);
  if (!photo) throw err(404, 'Foto no encontrada.');
  let widthPx = photo.widthPx || null;
  let heightPx = photo.heightPx || null;
  let sizeKb = photo.sizeKb || null;
  if (!widthPx || !heightPx || !sizeKb) {
    try {
      const bytes = await store.readPhotoBytes(photo);
      sizeKb = Math.max(1, Math.round(bytes.length / 1024));
      const dims = imageDimensions(bytes, photo.mimeType);
      if (dims) { widthPx = dims.width; heightPx = dims.height; }
      try { await store.updatePhoto(id, { widthPx, heightPx, sizeKb }); } catch (_) { /* sin guardar: se devuelve igual */ }
    } catch (_) { /* sin metadatos: se devuelven los que haya */ }
  }
  return { status: 200, data: { id: photo.id, filename: photo.filename, mimeType: photo.mimeType, widthPx, heightPx, sizeKb } };
}

// GET /api/shared-cart?ids=1,2,3 — público, sin sesión (el link se manda
// por WhatsApp a quien sea, tenga cuenta o no). Devuelve las fotos con
// su precio ACTUAL (se recalcula en vivo, como en el checkout) y los ids
// que ya no existen o ya no están en un evento (missing). Las fotos de un
// álbum ya caducado (fecha del evento + 60 días, decisión de Orlan
// 2026-11-17: el link caduca junto con el álbum) van aparte en `expired`
// para que el frontend diga que caducó en vez de "ya no existe". El link
// en sí no lleva fecha: la caducidad se decide al abrirlo, desde la fecha
// del evento. Máximo 100 ids (límite del carrito).
async function sharedCart(store, query) {
  const ids = String((query && query.ids) || '').split(',').map(s => Number(s)).filter(n => Number.isFinite(n) && n > 0);
  if (!ids.length) throw err(400, 'Faltan las fotos.');
  const uniq = [...new Set(ids)].slice(0, 100);
  const users = new Map((await store.listPhotographers()).map(u => [u.id, u]));
  const photos = [];
  const missing = [];
  const expired = [];
  for (const id of uniq) {
    const p = await store.getPhoto(id);
    if (!p) { missing.push(id); continue; }
    const ev = await store.getEvent(p.eventId);
    if (!ev) { missing.push(id); continue; }
    // Foto de un álbum oculto en un carrito compartido: el link es
    // público y no lleva sesión, así que no se puede saber si quien lo
    // abre es el dueño; se trata como si ya no existiera.
    // Lo mismo para un álbum "Próximo evento": aún no hay fotos que ver.
    if (ev.isHidden || ev.isUpcoming) { missing.push(id); continue; }
    const exp = eventExpiresAt(ev);
    if (exp && new Date(exp).getTime() <= Date.now()) { expired.push(id); continue; }
    const parts = await store.listParticipants(ev.id).catch(() => []);
    const pid = photoOwnerId(p, ev);
    const u = pid != null ? users.get(pid) : null;
    const part = pid != null ? parts.find(pt => Number(pt.photographerId) === pid) : null;
    photos.push({ ...p, photographerId: pid, photographerName: displayNameFor(u), eventName: ev.name, freeMode: ev.freeMode, priceMxn: part ? Number(part.priceMxn) : eventPrice(ev), filePath: undefined, storagePath: undefined, thumbPath: undefined });
  }
  return { status: 200, data: { photos, missing, expired } };
}

async function searchBib(store, user, query) {
  const bib = normBib(query.bib);
  if (!bib) throw err(400, 'Escribe un dorsal.');
  const eventId = query.eventId ? Number(query.eventId) : null;
  const events = eventId ? [await store.getEvent(eventId)].filter(Boolean) : await store.listEvents();
  const users = new Map((await store.listPhotographers()).map(u => [u.id, u]));
  const out = [];
  for (const ev of events) {
    // Búsqueda por dorsal no devuelve fotos de álbumes ocultos (salvo al dueño).
    if (isEventHiddenFor(user, ev)) continue;
    // Ni de álbumes "Próximo evento" (salvo al dueño): aún no hay fotos.
    if (ev.isUpcoming && !(user && user.isOwner)) continue;
    const parts = await store.listParticipants(ev.id).catch(() => []);
    const priceByPh = new Map(parts.map(pt => [Number(pt.photographerId), Number(pt.priceMxn)]));
    for (const p of await store.listPhotos(ev.id)) {
      if ((p.bibs || []).map(normBib).includes(bib)) {
        const pid = photoOwnerId(p, ev);
        const u = pid != null ? users.get(pid) : null;
        out.push({ ...p, photographerId: pid, photographerName: displayNameFor(u), eventName: ev.name, freeMode: ev.freeMode, priceMxn: (pid != null && priceByPh.has(pid)) ? priceByPh.get(pid) : eventPrice(ev), tipClabe: u ? (u.tipClabe || '') : '', tipName: displayNameFor(u), filePath: undefined, storagePath: undefined, thumbPath: undefined });
      }
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
    // Descarga gratis de un álbum oculto: solo el dueño.
    if (isEventHiddenFor(user, ev)) continue;
    // Álbum "Próximo evento": tampoco se registra descarga (salvo al dueño);
    // si no, se podría pagar una foto que luego no se puede descargar.
    if (ev.isUpcoming && !(user && user.isOwner)) continue;
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
  await expireOldEvents(store);
  const downloads = await store.listDownloadsByUser(user.id);
  // Panel rápido 2026-11-19 (D22): ANTES cada descarga pedía su foto,
  // su evento y su fotógrafo una por una (3 consultas por fila, en
  // serie). AHORA las tres cosas salen en lote (3 consultas en total);
  // si el store no tiene los métodos nuevos, una por una como antes.
  const photoIds = [...new Set(downloads.map(d => d.photoId))].filter(id => Number.isInteger(id));
  const eventIds = [...new Set(downloads.map(d => d.eventId))].filter(id => Number.isInteger(id));
  const photoRows = await tryStore(store, 'listPhotosByIds', photoIds);
  const eventRows = photoRows ? await tryStore(store, 'listEventsByIds', eventIds) : null;
  const photoById = photoRows ? new Map(photoRows.map(p => [p.id, p])) : null;
  const eventById = eventRows ? new Map(eventRows.map(e => [e.id, e])) : null;
  const pids = (photoById && eventById)
    ? [...new Set(downloads.map(d => { const p = photoById.get(d.photoId); if (!p) return null; return photoOwnerId(p, eventById.get(p.eventId)); }).filter(id => id != null))]
    : [];
  const userRows = (photoById && eventById) ? await tryStore(store, 'findUsersByIds', pids) : null;
  const userById = userRows ? new Map(userRows.filter(Boolean).map(u => [u.id, u])) : null;
  const photos = [];
  for (const d of downloads) {
    let p, ev, u;
    if (photoById && eventById && userById) {
      p = photoById.get(d.photoId); if (!p) continue;
      ev = eventById.get(d.eventId);
      const pid0 = photoOwnerId(p, ev);
      u = pid0 != null ? (userById.get(pid0) || null) : null;
    } else {
      p = await store.getPhoto(d.photoId); if (!p) continue;
      ev = await store.getEvent(d.eventId);
      const pid0 = photoOwnerId(p, ev);
      u = pid0 != null ? await store.findUserById(pid0) : null;
    }
    const pid = photoOwnerId(p, ev);
    photos.push({ ...p, photographerId: pid, photographerName: displayNameFor(u), eventName: ev ? ev.name : '', expiresAt: ev ? eventExpiresAt(ev) : null, freeMode: ev ? ev.freeMode : true, owned: true, amount: d.amount, downloadedAt: d.createdAt, filePath: undefined, storagePath: undefined, thumbPath: undefined });
  }
  return { status: 200, data: { photos } };
}

async function listSales(store, user) {
  requirePhotographer(user);
  const downloads = await store.listAllDownloads();
  // ANTES: por cada descarga se pedía la foto, el evento y el comprador
  // uno por uno (3 consultas por fila; con 178 descargas eran ~534
  // consultas seguidas y la pestaña de ventas tardaba muchísimo).
  // AHORA: todo se trae en bloque — una lista de eventos, las fotos de
  // cada evento distinto una sola vez, y los compradores distintos en
  // paralelo — y el resto se resuelve en memoria.
  const eventIds = [...new Set(downloads.map(d => d.eventId).filter(id => Number.isInteger(id)))];
  // Panel rápido 2026-11-19 (D22): las fotos de todos los eventos en
  // UNA consulta .in() (antes una por evento); si el store no tiene el
  // método nuevo, una por evento como antes.
  const [events, photoRows] = await Promise.all([
    store.listEvents(),
    (async () => {
      const batched = await tryStore(store, 'listPhotosByEventIds', eventIds);
      if (batched) return batched;
      return (await Promise.all(eventIds.map(id => store.listPhotos(id)))).flat();
    })(),
  ]);
  const photos = new Map();
  for (const ph of photoRows || []) photos.set(ph.id, ph);
  const eventById = new Map((events || []).map(e => [e.id, e]));
  // Cada fotógrafo ve SOLO las descargas de SUS FOTOS (en eventos
  // compartidos, las fotos de los demás no son suyas); el dueño ve todas.
  let mine = downloads;
  if (!user.isOwner) {
    mine = downloads.filter(d => {
      const ph = photos.get(d.photoId);
      if (!ph) return false;
      return photoOwnerId(ph, eventById.get(ph.eventId)) === user.id;
    });
  }
  const buyerIds = [...new Set(mine.map(d => d.userId).filter(id => Number.isInteger(id)))];
  // Panel rápido 2026-11-19 (D22): los compradores distintos en UNA
  // consulta .in() (antes uno por uno); si el store no tiene el método
  // nuevo, uno por uno como antes.
  const buyerRows = await tryStore(store, 'findUsersByIds', buyerIds);
  const buyers = buyerRows || await Promise.all(buyerIds.map(id => store.findUserById(id).catch(() => null)));
  const buyerById = new Map((buyers || []).filter(Boolean).map(u => [u.id, u]));
  const rows = [];
  let revenue = 0, freeCount = 0;
  for (const d of mine) {
    const ph = photos.get(d.photoId); const ev = eventById.get(d.eventId);
    const buyer = buyerById.get(d.userId);
    revenue += Number(d.amount || 0); if (!d.amount) freeCount += 1;
    rows.push({ id: d.id, photoId: d.photoId, eventName: ev ? ev.name : '', bibs: ph ? ph.bibs : [], buyerName: buyer ? buyer.name : '', amount: d.amount, createdAt: d.createdAt });
  }
  return { status: 200, data: { sales: rows, totalDownloads: rows.length, freeDownloads: freeCount, revenue } };
}

// ---- Estadísticas del fotógrafo (vistas) ----
// Las vistas se cuentan SOLO desde que se activa el registro: lo de
// antes no se puede recuperar. viewerKey es anónimo ('v:…' del navegador
// o 'u:<id>' con sesión): nunca se guarda el nombre de quien solo mira.
function cleanViewerKey(k) {
  const s = String(k || '').trim();
  if (!s || s.length > 64 || !/^[A-Za-z0-9:_-]+$/.test(s)) return null;
  return s;
}

async function trackView(store, user, body) {
  const kind = String(body.kind || '');
  if (kind !== 'photo' && kind !== 'event' && kind !== 'search') throw err(400, 'Tipo de vista no válido.');
  let photoId = null, eventId = null, bib = '';
  if (kind === 'photo') {
    photoId = Number(body.photoId);
    if (!Number.isInteger(photoId)) throw err(400, 'Falta la foto.');
    const p = await store.getPhoto(photoId);
    if (!p) throw err(404, 'Foto no encontrada.');
    eventId = p.eventId;
  } else if (kind === 'event') {
    eventId = Number(body.eventId);
    if (!Number.isInteger(eventId)) throw err(400, 'Falta el evento.');
    const ev = await store.getEvent(eventId);
    if (!ev) throw err(404, 'Evento no encontrado.');
  } else {
    bib = normBib(body.bib);
    if (!bib || bib.includes('@')) throw err(400, 'Escribe solo tu número de dorsal, sin correo.');
    if (body.eventId != null && body.eventId !== '') {
      const ev = await store.getEvent(Number(body.eventId));
      if (ev) eventId = ev.id;
    }
  }
  const viewerKey = (user && user.id) ? ('u:' + user.id) : (cleanViewerKey(body.viewerKey) || 'anon');
  const v = { kind, photoId, eventId, bib, viewerKey };
  if (await store.hasViewToday(v)) return { status: 200, data: { ok: true, counted: false } };
  await store.recordView(v);
  return { status: 200, data: { ok: true, counted: true } };
}

async function listStats(store, user) {
  requirePhotographer(user);
  // Tres listas independientes: se piden a la vez, no una tras otra.
  let [views, downloads, events] = await Promise.all([store.listViews(), store.listAllDownloads(), store.listEvents()]);
  if (!user.isOwner) {
    // Cada fotógrafo ve SOLO las estadísticas de sus eventos: los que
    // creó y los compartidos en los que participa. El dueño ve todas.
    // Las vistas sin evento (búsqueda global) no se pueden atribuir y no
    // se cuentan para nadie más.
    const joined = new Set(await store.listJoinedEventIds(user.id).catch(() => []));
    const own = new Set(events.filter(e => e.photographerId === user.id || joined.has(e.id)).map(e => e.id));
    events = events.filter(e => own.has(e.id));
    views = views.filter(v => v.eventId != null && own.has(v.eventId));
    downloads = downloads.filter(d => own.has(d.eventId));
  }
  const photos = new Map();
  // Panel rápido 2026-11-19 (D22): las fotos de todos los eventos en
  // UNA consulta .in() (antes una por evento); si el store no tiene el
  // método nuevo, una por evento como antes.
  const photoRows = await tryStore(store, 'listPhotosByEventIds', events.map(ev => ev.id));
  if (photoRows) { for (const p of photoRows) photos.set(p.id, p); }
  else { for (const list of await Promise.all(events.map(ev => store.listPhotos(ev.id)))) for (const p of list || []) photos.set(p.id, p); }
  const eventById = new Map(events.map(e => [e.id, e]));
  if (!user.isOwner) {
    // En un evento compartido: las descargas y las vistas de FOTO son
    // de quien subió esa foto (las visitas al evento sí se ven para
    // todos los participantes, porque el evento también es suyo).
    downloads = downloads.filter(d => {
      const p = photos.get(d.photoId);
      if (!p) return false;
      const ev = eventById.get(p.eventId);
      return photoOwnerId(p, ev) === user.id;
    });
    views = views.filter(v => {
      if (v.kind !== 'photo' || v.photoId == null) return true;
      const p = photos.get(v.photoId);
      if (!p) return false;
      const ev = eventById.get(p.eventId);
      return photoOwnerId(p, ev) === user.id;
    });
  }
  let photoViews = 0, eventViews = 0;
  const viewers = new Set();
  const perEvent = new Map();
  for (const ev of events) perEvent.set(ev.id, { eventId: ev.id, name: ev.name, photoCount: ev.photoCount || 0, photoViews: 0, uniqueViewers: new Set(), eventViews: 0, downloads: 0, revenue: 0 });
  const photoViewCount = new Map(), photoDlCount = new Map(), bibSearches = new Map();
  for (const v of views) {
    // Toda vista con visitante cuenta como visitante único (foto, evento
    // o búsqueda); por evento solo cuentan sus fotos, sus visitas y sus
    // búsquedas dentro de ese evento.
    if (v.viewerKey) viewers.add(v.viewerKey);
    if (v.kind === 'photo') {
      photoViews += 1;
      if (v.photoId != null) photoViewCount.set(v.photoId, (photoViewCount.get(v.photoId) || 0) + 1);
      if (v.eventId != null && perEvent.has(v.eventId)) {
        const pe = perEvent.get(v.eventId);
        pe.photoViews += 1;
        if (v.viewerKey) pe.uniqueViewers.add(v.viewerKey);
      }
    } else if (v.kind === 'event') {
      eventViews += 1;
      if (v.eventId != null && perEvent.has(v.eventId)) {
        const pe = perEvent.get(v.eventId);
        pe.eventViews += 1;
        if (v.viewerKey) pe.uniqueViewers.add(v.viewerKey);
      }
    } else if (v.kind === 'search') {
      if (v.bib) bibSearches.set(v.bib, (bibSearches.get(v.bib) || 0) + 1);
      if (v.eventId != null && perEvent.has(v.eventId) && v.viewerKey) perEvent.get(v.eventId).uniqueViewers.add(v.viewerKey);
    }
  }
  let totalDownloads = 0, freeDownloads = 0, revenue = 0;
  for (const d of downloads) {
    totalDownloads += 1;
    revenue += Number(d.amount || 0);
    if (!d.amount) freeDownloads += 1;
    if (d.photoId != null) photoDlCount.set(d.photoId, (photoDlCount.get(d.photoId) || 0) + 1);
    if (d.eventId != null && perEvent.has(d.eventId)) {
      const pe = perEvent.get(d.eventId);
      pe.downloads += 1;
      pe.revenue += Number(d.amount || 0);
    }
  }
  // Desempate determinista: a igualdad de vistas, primero la foto con
  // más descargas y luego el id menor (listViews viene en orden
  // descendente, así que sin desempate el orden del empate dependería
  // de qué foto se vio más recientemente).
  const topPhotos = [...photoViewCount.entries()]
    .sort((a, b) => b[1] - a[1] || (photoDlCount.get(b[0]) || 0) - (photoDlCount.get(a[0]) || 0) || a[0] - b[0]).slice(0, 10)
    .map(([photoId, views]) => {
      const p = photos.get(photoId);
      const ev = p ? eventById.get(p.eventId) : null;
      return { photoId, eventId: p ? p.eventId : null, eventName: ev ? ev.name : '', bibs: p ? (p.bibs || []) : [], views, downloads: photoDlCount.get(photoId) || 0 };
    });
  const topBibs = [...bibSearches.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 10)
    .map(([bib, searches]) => ({ bib, searches }));
  const evRows = [...perEvent.values()].map(pe => ({ eventId: pe.eventId, name: pe.name, photoCount: pe.photoCount, photoViews: pe.photoViews, uniqueViewers: pe.uniqueViewers.size, eventViews: pe.eventViews, downloads: pe.downloads, revenue: pe.revenue }));
  return { status: 200, data: {
    totals: { photoViews, uniqueViewers: viewers.size, eventViews, totalDownloads, freeDownloads, revenue },
    events: evRows,
    topPhotos,
    topBibs,
  } };
}

async function setFreeMode(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(body.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.photographerId !== user.id) throw err(403, 'Ese evento no es tuyo.');
  // Un álbum exclusivo OnlyClick siempre es gratis (el organizador paga
  // directo al dueño): no se puede cambiar a pago.
  if (ev.isExclusive && body.freeMode === false) throw err(400, 'Un álbum exclusivo OnlyClick siempre es gratis.');
  const updated = await store.updateEvent(ev.id, { freeMode: body.freeMode !== false });
  return { status: 200, data: { event: updated } };
}

// POST /api/set-event-hidden { eventId, isHidden } — oculta o muestra un
// álbum. SOLO el dueño (isOwner) y SOLO un álbum que él creó. Un álbum
// oculto es invisible para todos menos el dueño (listas, búsquedas,
// link directo, fotos y portada). Los fotógrafos que participaban en
// ese evento también dejan de verlo.
async function setEventHidden(store, user, body) {
  requireOwner(user);
  const ev = await store.getEvent(body.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.photographerId !== user.id) throw err(403, 'Ese evento no es tuyo.');
  const updated = await store.updateEvent(ev.id, { isHidden: body.isHidden === true });
  return { status: 200, data: { event: updated } };
}

// POST /api/set-event-upcoming { eventId, isUpcoming } — marca o quita
// un álbum como "Próximo evento". SOLO el dueño (isOwner) y SOLO un
// álbum que él creó (mismo patrón que set-event-hidden). Un álbum
// próximo se ve en las listas con la etiqueta "Próximo evento", sin
// precio y sin abrirse para nadie que no sea el dueño; el dueño sí lo
// abre para subir fotos y gestionarlo.
async function setEventUpcoming(store, user, body) {
  requireOwner(user);
  const ev = await store.getEvent(body.eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.photographerId !== user.id) throw err(403, 'Ese evento no es tuyo.');
  const updated = await store.updateEvent(ev.id, { isUpcoming: body.isUpcoming === true });
  return { status: 200, data: { event: updated } };
}

async function setTip(store, user, body) {
  requirePhotographer(user);
  const clabe = String(body.clabe || '').replace(/[\s-]/g, '');
  if (clabe && !/^\d{18}$/.test(clabe)) throw err(400, 'La CLABE debe tener 18 dígitos.');
  if (clabe) {
    // Bloqueo: si TODOS sus álbumes son de pago, la cooperación voluntaria
    // está desactivada (el mensaje de propina solo sale en fotos gratis).
    // Sin álbumes todavía, se permite guardarla para cuando cree uno gratis.
    // Quitar la CLABE (vacía) siempre se permite.
    const events = await store.listEvents();
    const joined = new Set(await store.listJoinedEventIds(user.id).catch(() => []));
    const mine = events.filter(e => e.photographerId === user.id || joined.has(e.id));
    if (mine.length && !mine.some(e => e.freeMode)) throw err(400, 'La cooperación voluntaria está desactivada porque tus álbumes son de pago.');
  }
  const updated = await store.setTipClabe(user.id, clabe);
  return { status: 200, data: { tipClabe: updated ? (updated.tipClabe || '') : clabe } };
}

// Quitar una foto de "Mis fotos": solo la ESCONDE de la lista del
// atleta (removed_at); el registro de la descarga NO se borra, así las
// estadísticas y las ganancias la siguen contando (Orlan, 2026-11-20:
// quitar de la lista no debe borrar la venta). La foto del álbum NO se
// borra (sigue en el evento y otros la pueden comprar).
// También se pueden quitar las fotos DE PAGO (Orlan, 2026-11-19): la
// pantalla avisa antes que si la quita, ya no la podrá descargar sin
// volver a pagarla. El que quita es el comprador, con el aviso enfrente.
async function removeDownload(store, user, body) {
  requireUser(user);
  const photoId = Number(body.photoId);
  if (!photoId) throw err(400, 'Falta la foto.');
  const mine = (await store.listDownloadsByUser(user.id)).filter(d => d.photoId === photoId);
  if (!mine.length) throw err(404, 'Esa foto no está en tus fotos.');
  await store.removeDownloadsByUserPhoto(user.id, photoId);
  return { status: 200, data: { ok: true } };
}

async function updatePhoto(store, user, body) {
  requirePhotographer(user);
  const p = await store.getPhoto(body.photoId);
  if (!p) throw err(404, 'Foto no encontrada.');
  const ev = await store.getEvent(p.eventId);
  if (!ev || !(await isPhotoOwner(user, p, ev))) throw err(403, 'Esa foto no es tuya.');
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
  if (!ev || !(await isPhotoOwner(user, p, ev))) throw err(403, 'Esa foto no es tuya.');
  // Una foto ya vendida no se borra: quien pagó por ella perdería su
  // acceso. Las descargas gratis no bloquean (la foto solo desaparece
  // de la lista de Mis fotos de quien la guardó gratis).
  if (await store.hasPaidDownload(p.id)) throw err(400, 'Esta foto ya se vendió y no se puede eliminar: alguien ya pagó por ella.');
  // store.deletePhoto borra también sus caras indexadas (Fase 2) y
  // devuelve sus FaceIds: se borran de Rekognition (mejor esfuerzo).
  // Si el borrado de la foto falla, el error se propaga como antes.
  const faceIds = await store.deletePhoto(p.id);
  if (faceIds && faceIds.length) {
    try { await rekognition.deleteFaces(rekognition.collectionIdFor(ev.id), faceIds); } catch (_) {}
  }
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
  const ev = await store.getEvent(eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  // Portada de un álbum oculto: no se sirve a nadie que no sea el dueño.
  assertEventVisible(user, ev);
  const cover = await store.getEventCover(eventId);
  if (!cover) throw err(404, 'Este evento no tiene portada.');
  // La portada es igual para todos los que ven el evento (el álbum
  // oculto exige token en la URL, así que su clave de caché es solo del
  // dueño; un anónimo recibe 404 sin headers de caché). Cacheable: true.
  return { status: 200, file: { bytes: cover.bytes, mimeType: cover.mimeType, filename: `onlyclick-portada-${eventId}.jpg`, inline: true, cacheable: true } };
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
  // Fase 2: al borrar el evento se borra también su colección de caras
  // en Rekognition (mejor esfuerzo: si falla, no rompe el borrado).
  try { await rekognition.deleteCollection(rekognition.collectionIdFor(ev.id)); } catch (_) {}
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
    if (!ev || !(await isPhotoOwner(user, p, ev))) throw err(403, 'Esa foto no es tuya.');
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

// Llama a Gemini con varias imágenes y pide JSON. Prueba los modelos en
// orden (3.8 -> 3.6 -> 3.5-lite) y solo reintenta con otro modelo si es
// saturación (503) o límite (429). Igual que readBib, pero genérico para
// que lo use la búsqueda por selfie (readBib se deja como está).
async function geminiVisionJson(key, parts) {
  const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
  let lastErr = null;
  for (const model of MODELS) {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
    });
    if (res.ok) {
      const json = await res.json();
      const text = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text) || '';
      return { ok: true, text };
    }
    let detail = '';
    try { const ej = await res.json(); detail = String((ej.error && ej.error.message) || '').slice(0, 120); } catch (_) {}
    lastErr = { status: res.status, detail };
    if (res.status !== 503 && res.status !== 429) break;
  }
  return { ok: false, status: lastErr.status, detail: lastErr.detail };
}

// ---- Ayudas compartidas por la búsqueda por selfie (Fase 1 y 2) ----
// faceSearchEvent: el evento existe y no caducó (dispara la limpieza de
// álbumes viejos igual que getEvent) y respeta las reglas de la Fase 1
// actual: álbumes ocultos y "Próximo evento" solo los ve el dueño.
// parseFaceSelfie: valida la selfie (vacía, más de 2 MB o no imagen ->
// 400). enrichFaceMatches: las fotos con la misma forma que la búsqueda
// por dorsal (autor, precio por foto, nombre del evento, modo gratis/pago
// y si ya es tuya con sesión).
async function faceSearchEvent(store, user, eventId) {
  await expireOldEvents(store);
  const ev = await store.getEvent(eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  const exp = eventExpiresAt(ev);
  if (exp && new Date(exp).getTime() <= Date.now()) throw err(404, 'Este álbum ya caducó.');
  // Búsqueda por selfie no toca álbumes ocultos (salvo al dueño).
  assertEventVisible(user, ev);
  // Ni álbumes "Próximo evento" (salvo al dueño): aún no hay fotos.
  if (ev.isUpcoming && !(user && user.isOwner)) throw err(404, 'Este álbum aún no tiene fotos. Las fotos estarán disponibles después de la carrera.');
  return ev;
}
function parseFaceSelfie(body) {
  const selfieBase64 = String(body.selfieBase64 || '');
  if (!selfieBase64) throw err(400, 'Falta tu selfie.');
  const buf = Buffer.from(selfieBase64, 'base64');
  if (!buf.length || buf.length > FACE_SELFIE_MAX_BYTES) throw err(400, 'La selfie está vacía o pesa más de 2 MB.');
  const mime = String(body.mimeType || 'image/jpeg');
  if (!mime.startsWith('image/')) throw err(400, 'La selfie no es una imagen.');
  return { buf, mime };
}
async function enrichFaceMatches(store, user, ev, photos) {
  const users = new Map((await store.listPhotographers()).map(u => [u.id, u]));
  const partsRows = await store.listParticipants(ev.id).catch(() => []);
  const priceByPh = new Map(partsRows.map(pt => [Number(pt.photographerId), Number(pt.priceMxn)]));
  const owned = new Set();
  if (user) for (const d of await store.listDownloadsByUser(user.id)) owned.add(d.photoId);
  return photos.map(p => {
    const pid = photoOwnerId(p, ev);
    const u = pid != null ? users.get(pid) : null;
    return { ...p, photographerId: pid, photographerName: displayNameFor(u), eventName: ev.name, freeMode: ev.freeMode, priceMxn: (pid != null && priceByPh.has(pid)) ? priceByPh.get(pid) : eventPrice(ev), tipClabe: u ? (u.tipClabe || '') : '', tipName: displayNameFor(u), owned: owned.has(p.id), filePath: undefined, storagePath: undefined, thumbPath: undefined };
  });
}

// Búsqueda por selfie (Fase 1, reconocimiento facial con Gemini).
// POST { eventId, selfieBase64, mimeType, offset, limit }.
// Compara LA SELFIE contra UN LOTE de fotos del evento (máx. 8 por
// llamada) y devuelve solo las fotos donde aparece la misma persona.
// El cliente va pidiendo lotes seguidos (offset/limit) hasta terminar el
// evento, con varias llamadas en paralelo, y muestra el avance. Así
// ninguna llamada tarda más de ~10 s (límite de Vercel en el plan gratis).
// La selfie NO se guarda: solo viaja en el cuerpo de cada llamada y el
// servidor la usa y la olvida. Pública como la búsqueda por dorsal: para
// descargar una foto de pago sigue haciendo falta sesión y compra.
// Fotos sin cara visible simplemente no coinciden (no es un error).
// Sin GEMINI_API_KEY devuelve { ok:false, reason:'no-key' }.
async function faceSearch(store, user, body) {
  const key = (process.env.GEMINI_API_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();
  if (!key) return { status: 200, data: { ok: false, reason: 'no-key' } };
  const eventId = Number(body.eventId);
  if (!Number.isInteger(eventId)) throw err(400, 'Falta el evento.');
  const ev = await faceSearchEvent(store, user, eventId);
  const { buf: selfieBuf, mime: selfieMime } = parseFaceSelfie(body);
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(FACE_BATCH_MAX, Math.max(1, Number(body.limit) || FACE_BATCH_MAX));
  const all = await store.listPhotos(eventId);
  const total = Math.min(all.length, FACE_SEARCH_MAX_PHOTOS);
  const batch = all.slice(offset, Math.min(offset + limit, total));
  // Las fotos se comparan por su miniatura (400px, ~30-50 KB) cuando
  // existe: gasta menos tokens y es más rápida. Sin miniatura (fotos
  // viejas) se usa la foto completa. Si no se puede leer una foto, se
  // salta sin romper el lote.
  const candidates = (await Promise.all(batch.map(async p => {
    let bytes = null; let mime = p.mimeType || 'image/jpeg';
    try { bytes = await store.readThumbBytes(p); if (bytes) mime = 'image/jpeg'; } catch (_) {}
    if (!bytes) { try { bytes = await store.readPhotoBytes(p); } catch (_) {} }
    return bytes && bytes.length ? { photo: p, bytes, mime } : null;
  }))).filter(Boolean);
  if (!candidates.length) {
    return { status: 200, data: { ok: true, matches: [], total, checked: batch.length, nextOffset: offset + batch.length, done: offset + batch.length >= total } };
  }
  const prompt = 'La primera imagen es una selfie de una persona. Las siguientes ' + candidates.length + ' imágenes son fotos de una carrera, en orden. Dime en cuáles de esas fotos aparece LA MISMA persona de la selfie (mismo rostro). Compara la cara: rasgos, pelo, forma. Si en una foto no se ve ninguna cara clara, o la cara no es la misma persona, NO la incluyas. Responde solo con este JSON: {"matches": [0, 2]} con los índices (0 = la primera foto después de la selfie) de las fotos donde aparece la misma persona. Si ninguna coincide, responde {"matches": []}.';
  const parts = [{ text: prompt }, { inlineData: { mimeType: selfieMime, data: selfieBuf.toString('base64') } }];
  for (const c of candidates) parts.push({ inlineData: { mimeType: c.mime, data: c.bytes.toString('base64') } });
  const r = await geminiVisionJson(key, parts);
  if (!r.ok) return { status: 200, data: { ok: false, reason: 'ia-error', status: r.status, detail: r.detail } };
  let idxs = [];
  try {
    const parsed = JSON.parse(String(r.text || '').replace(/```json|```/g, '').trim());
    const raw = parsed && Array.isArray(parsed.matches) ? parsed.matches : [];
    idxs = [...new Set(raw.map(v => Number(v)).filter(v => Number.isInteger(v) && v >= 0 && v < candidates.length))];
  } catch (_) {
    // Si la IA no devolvió JSON limpio, se rescatan los índices que sí
    // vengan como números en el texto (mismo rescate que readBib).
    idxs = [...new Set((String(r.text || '').match(/\d+/g) || []).map(v => Number(v)).filter(v => Number.isInteger(v) && v >= 0 && v < candidates.length))];
  }
  // Las coincidencias se devuelven con la misma forma que la búsqueda por
  // dorsal (searchBib): autor, precio por foto, nombre del evento, modo
  // gratis/pago y si ya es tuya (cuando hay sesión).
  const matches = await enrichFaceMatches(store, user, ev, idxs.map(i => candidates[i].photo));
  return { status: 200, data: { ok: true, matches, total, checked: batch.length, nextOffset: offset + batch.length, done: offset + batch.length >= total } };
}

// Búsqueda por selfie INSTANTÁNEA (Fase 2, Rekognition).
// POST { eventId, selfieBase64, mimeType } — UNA sola llamada: compara la
// selfie contra las huellas ya indexadas del evento y devuelve las fotos
// donde aparece la persona, en segundos. Misma forma de respuesta que la
// Fase 1 (autor, precio, evento, gratis/pago, owned) + instant:true.
// La selfie NO se guarda. Pública como la búsqueda por dorsal.
// Si el evento aún no tiene índice -> { ok:false, reason:'no-index' } y
// el cliente cae a la Fase 1 (lotes con Gemini): la búsqueda nunca se
// rompe. Sin llaves de AWS -> 'no-key'. Si en la selfie no se ve ninguna
// cara -> 'no-face'. Otros errores de Rekognition -> 'ia-error'.
async function faceSearchInstant(store, user, body) {
  const eventId = Number(body.eventId);
  if (!Number.isInteger(eventId)) throw err(400, 'Falta el evento.');
  const ev = await faceSearchEvent(store, user, eventId);
  const { buf: selfieBuf } = parseFaceSelfie(body);
  if (!rekognition.isConfigured()) return { status: 200, data: { ok: false, reason: 'no-key' } };
  // Sin tabla photo_faces (falta correr el SQL) la lectura devuelve [] y
  // se cae a la Fase 1, igual que si el evento no tuviera índice.
  const index = await store.listFaceIndex(eventId).catch(() => []);
  if (!index.length) return { status: 200, data: { ok: false, reason: 'no-index' } };
  const collectionId = rekognition.collectionIdFor(eventId);
  let res;
  try {
    res = await rekognition.searchFacesByImage(collectionId, selfieBuf, { threshold: FACE2_SIMILARITY_MIN, maxFaces: 100 });
  } catch (e) {
    if (e.code === 'InvalidParameterException') return { status: 200, data: { ok: false, reason: 'no-face', detail: String(e.message || '').slice(0, 120) } };
    return { status: 200, data: { ok: false, reason: 'ia-error', status: e.status || 500, detail: String(e.message || '').slice(0, 120) } };
  }
  const byFace = new Map(index.map(r => [r.faceId, r.photoId]));
  const best = new Map(); // photoId -> mayor parecido (una foto puede tener varias caras)
  for (const m of (res.FaceMatches || [])) {
    const faceId = m.Face && m.Face.FaceId;
    const sim = Number(m.Similarity);
    if (!faceId || !byFace.has(faceId) || !Number.isFinite(sim) || sim < FACE2_SIMILARITY_MIN) continue;
    const pid = byFace.get(faceId);
    if (!best.has(pid) || sim > best.get(pid)) best.set(pid, sim);
  }
  const all = await store.listPhotos(eventId);
  const byId = new Map(all.map(p => [p.id, p]));
  const photos = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([pid]) => byId.get(pid)).filter(Boolean);
  const matches = await enrichFaceMatches(store, user, ev, photos);
  for (const m of matches) m.similarity = Math.round(best.get(m.id) * 10) / 10;
  return { status: 200, data: { ok: true, instant: true, matches, total: all.length, indexed: index.length, similarityMin: FACE2_SIMILARITY_MIN } };
}

// Indexa las caras de fotos de un evento en Rekognition (Fase 2).
// POST { eventId, photoIds:[...] } (fotos concretas, p. ej. recién
// subidas) o { eventId, photoId } (una foto) o { eventId, offset, limit }
// (backfill: las siguientes fotos del evento que aún no tienen ninguna
// cara indexada). Máx. 8 fotos por llamada (límite de Vercel ~10 s; el
// cliente repite con offset hasta terminar). Solo fotógrafos que
// participen en el evento. Crea la colección si no existe (una por
// evento). Las fotos sin cara no son error (se cuentan en noFace).
// Sin llaves de AWS -> { ok:false, reason:'no-key' }.
async function indexPhotoFaces(store, user, body) {
  requirePhotographer(user);
  const eventId = Number(body.eventId);
  if (!Number.isInteger(eventId)) throw err(400, 'Falta el evento.');
  const ev = await store.getEvent(eventId);
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (!isEventOwner(user, ev)) {
    const part = await store.getParticipant(ev.id, user.id).catch(() => null);
    if (!part) throw err(403, 'No participas en ese evento.');
  }
  if (!rekognition.isConfigured()) return { status: 200, data: { ok: false, reason: 'no-key' } };
  const limit = Math.min(FACE2_INDEX_CHUNK_MAX, Math.max(1, Number(body.limit) || FACE2_INDEX_CHUNK_MAX));
  let photos = [];
  let total = 0, nextOffset = 0, done = true;
  if (Array.isArray(body.photoIds) && body.photoIds.length) {
    const ids = [...new Set(body.photoIds.map(Number).filter(Number.isInteger))].slice(0, limit);
    for (const id of ids) { const p = await store.getPhoto(id); if (p && Number(p.eventId) === eventId) photos.push(p); }
    total = photos.length; done = true;
  } else if (body.photoId) {
    const p = await store.getPhoto(Number(body.photoId));
    if (p && Number(p.eventId) === eventId) photos = [p];
    total = photos.length; done = true;
  } else {
    // Backfill: el offset/limit recorren TODAS las fotos del evento en
    // orden (no solo las pendientes): así el offset es estable entre
    // llamadas aunque las fotos se vayan indexando. Dentro de cada tanda
    // se saltan las que ya tienen cara indexada.
    const all = await store.listPhotos(eventId);
    const indexed = new Set((await store.listFaceIndex(eventId).catch(() => [])).map(r => r.photoId));
    const offset = Math.max(0, Number(body.offset) || 0);
    const slice = all.slice(offset, offset + limit);
    photos = slice.filter(p => !indexed.has(p.id));
    total = all.length; nextOffset = offset + slice.length; done = nextOffset >= all.length;
  }
  const collectionId = rekognition.collectionIdFor(eventId);
  try { await rekognition.createCollection(collectionId); }
  catch (e) {
    if (e.code !== 'ResourceAlreadyExistsException') return { status: 200, data: { ok: false, reason: 'ia-error', status: e.status || 500, detail: String(e.message || '').slice(0, 120) } };
  }
  let indexed = 0, faces = 0, noFace = 0; const errors = [];
  for (const p of photos) {
    let bytes = null;
    try { bytes = await store.readPhotoBytes(p); } catch (_) {}
    if (!bytes || !bytes.length) { errors.push({ photoId: p.id, error: 'no se pudo leer la foto' }); continue; }
    let recs;
    try { recs = await rekognition.indexFaces(collectionId, bytes, String(p.id)); }
    catch (e) { errors.push({ photoId: p.id, error: String(e.message || '').slice(0, 80) }); continue; }
    const good = (recs || []).filter(r => r.Face && r.Face.FaceId && Number(r.Face.Confidence || 0) >= FACE2_FACE_CONFIDENCE_MIN);
    if (!good.length) { noFace++; continue; }
    const rows = good.map(r => ({ eventId, photoId: p.id, faceId: r.Face.FaceId, collectionId }));
    try { await store.addFaceIndex(rows); indexed++; faces += rows.length; }
    catch (e) { errors.push({ photoId: p.id, error: 'no se pudo guardar el índice' }); }
  }
  return { status: 200, data: { ok: true, indexed, faces, noFace, errors, total, nextOffset, done } };
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
  // Foto de un álbum oculto: ni la miniatura ni el original se sirven a
  // nadie que no sea el dueño (sin esto el álbum se podría ver por id).
  assertEventVisible(user, ev);
  // Foto de un álbum "Próximo evento": tampoco se sirve a nadie que no
  // sea el dueño (la portada sí se ve en la tarjeta, esa va por
  // cover-file y no se bloquea).
  if (ev.isUpcoming && !(user && user.isOwner)) throw err(404, 'Foto no encontrada.');
  const inline = req && req.query && req.query.inline === '1';
  if (!ev.freeMode && !inline) {
    // Evento de pago: la vista previa (inline) se permite para ver la foto,
    // pero la descarga del archivo original exige haberla comprado.
    // Nota: esta versión no añade marca de agua a la vista previa; si el
    // fotógrafo vende fotos, conviene añadirla antes de cobrar de verdad.
    if (!user) throw err(401, 'Inicia sesión para descargar esta foto.');
    // Solo el fotógrafo DE ESTA FOTO (o el dueño) descarga gratis: los
    // demás fotógrafos son corredores como cualquier otro y deben comprar.
    if (!(await isPhotoOwner(user, photo, ev)) && !(await store.hasDownload(user.id, photo.id))) throw err(403, 'Esta foto es de pago. Cómprala primero.');
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
  if (!bytes && inline && !ev.freeMode && !(user && ((await isPhotoOwner(user, photo, ev)) || await store.hasDownload(user.id, photo.id)))) {
    bytes = await store.readThumbBytes(photo);
    if (bytes) mimeType = 'image/jpeg';
  }
  if (!bytes) bytes = await store.readPhotoBytes(photo);
  // ¿Se puede guardar en el caché del edge de Vercel? Solo cuando los
  // bytes NO dependen de quién pide: la miniatura es siempre la misma, y
  // la foto completa de un evento gratis también. En un evento de pago la
  // misma URL devuelve la miniatura (sin comprar) o el original
  // (comprado): si el edge la guardara, quien compró podría recibir la
  // miniatura o quien no compró el original. La descarga (sin inline)
  // nunca se cachea: exige sesión y compra. (El wrapper api/photo.js
  // traduce este flag a s-maxage o a no-store.)
  const cacheable = (req && req.query && req.query.thumb === '1') || (inline && ev.freeMode);
  return { status: 200, file: { bytes, mimeType, filename: `onlyclick-foto-${photo.id}.${(photo.filename || 'foto.jpg').split('.').pop() || 'jpg'}`, inline: req && req.query && req.query.inline === '1', cacheable } };
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

// ---- Precios del carrito (decisión FINAL del dueño 2026-11-16) ----
// Los paquetes son APARTE, no un descuento por foto desde la 6a.
// Fotos INDIVIDUALES: 1-3 a precio normal, 4a y 5a con 20% de descuento
// cada una, 6a en adelante a precio NORMAL (sin descuento).
// PAQUETES (producto aparte): el carrito forma AUTOMÁTICAMENTE
// floor(N/10) paquetes de 10 fotos; cada paquete cuesta 25% menos que el
// total de sus 10 fotos. Las fotos restantes se cobran individuales con
// la regla de arriba. NINGÚN precio está fijo en el código: todos salen
// de events.price_mxn (editable por evento), así los porcentajes sirven
// con cualquier precio ($20/foto -> paquete $150; $50/foto -> $375).
// Para precios mezclados, las fotos se ordenan por precio descendente y
// luego id ascendente antes de formar los paquetes (los paquetes se
// llevan las más caras: máximo ahorro). Misma regla en cliente y servidor.
// El precio de un paquete se reparte por foto en partes enteras que suman
// EXACTAMENTE el total del paquete, así lo que se muestra, lo que se cobra
// y lo que queda registrado por foto coinciden al peso.
// Para cambiar los porcentajes o el tamaño del paquete se toca SOLO este
// bloque aquí y su gemelo en public/app.js; el servidor siempre manda.
const PACKAGE_SIZE = 10;
const PACKAGE_DISCOUNT = 0.25;
const CART_MAX_TOTAL = 5000; // límite de Clip por transacción (MXN)
// Caducidad de álbumes (Orlan, 2026-11-16): un evento se borra solo 60
// días después de su fecha, para no guardar álbumes viejos que ya nadie
// mueve. El aviso sale cuando faltan 15 días o menos.
const EVENT_EXPIRY_DAYS = 60;
const EXPIRY_WARN_DAYS = 15;
const CART_MAX_ITEMS = 100; // máximo de fotos por carrito
// ---- Búsqueda por selfie, Fase 1 (Orlan, 2026-11-17) ----
// La selfie se compara contra las fotos del evento en LOTES pequeños
// (FACE_BATCH_MAX por llamada a Gemini). El cliente pide los lotes
// seguidos, varios en paralelo, y muestra el avance. Así ninguna llamada
// tarda más de ~10 s (límite de Vercel en el plan gratis) y la búsqueda
// completa de un evento grande tarda ~1-3 min. La selfie NO se guarda:
// solo viaja en el cuerpo de cada llamada y el servidor la usa y la
// olvida. Sin cobro en Fase 1 (los rostros pre-calculados son Fase 2).
const FACE_BATCH_MAX = 8; // fotos del evento por llamada a Gemini
const FACE_SEARCH_MAX_PHOTOS = 1000; // tope de fotos por búsqueda
const FACE_SELFIE_MAX_BYTES = 2 * 1024 * 1024; // selfie máx. 2 MB decodificada
// ---- Búsqueda por selfie instantánea, Fase 2 (Rekognition) ----
// Al subir una foto se indexan sus caras (huellas) en una colección de
// Rekognition por evento; buscar es comparar la selfie contra esas
// huellas, en segundos. Si el evento aún no tiene índice, la búsqueda
// cae a la Fase 1 (lotes con Gemini) y nunca se rompe.
const FACE2_SIMILARITY_MIN = 90; // % mínimo de parecido para devolver una foto
const FACE2_INDEX_CHUNK_MAX = 8; // fotos por llamada a index-photo-faces (límite Vercel ~10 s)
const FACE2_FACE_CONFIDENCE_MIN = 80; // confianza mínima de Rekognition para guardar una cara
const SINGLE_TIERS = [
  { from: 1, to: 3, discount: 0 },
  { from: 4, to: 5, discount: 0.20 },
  { from: 6, to: Infinity, discount: 0 },
];

function singleDiscountForPosition(pos) {
  for (const t of SINGLE_TIERS) if (pos >= t.from && pos <= t.to) return t.discount;
  return 0;
}

// Reparte `total` en n partes (con centavos) que suman exactamente total.
// Antes era solo en pesos enteros: un paquete de 10 a $25 ($187.50) se
// repartía como 8×$19 + 2×$18 = $188, un peso más que el cobro.
function splitAmount(total, n) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const rem = cents - base * n;
  const out = [];
  for (let i = 0; i < n; i++) out.push((base + (i < rem ? 1 : 0)) / 100);
  return out;
}

// items: [{ id, price }] — devuelve { packages: [{ photoIds, subtotal,
// discount, total, amounts }], lines: [{ id, price, discount, lineTotal
// }] (fotos individuales), subtotal, discount, total, codePercent,
// codeDiscount, volumeDiscount }.
// Misma fórmula que el cliente (public/app.js).
// codePercent (opcional): descuento EXTRA de un código, DESPUÉS de los
// descuentos por volumen y sobre el total final: cada paquete y cada
// línea individual se rebajan en ese % (en centavos), así las filas de
// pago siguen sumando exactamente el total. Sin código el resultado es
// idéntico al de antes (codeDiscount 0, volumeDiscount = discount).
function cartTotals(items, codePercent) {
  const pct = Math.min(100, Math.max(0, Number(codePercent) || 0)) / 100;
  const sorted = items.slice().sort((a, b) => (Number(b.price) - Number(a.price)) || (Number(a.id) - Number(b.id)));
  const numPackages = Math.floor(sorted.length / PACKAGE_SIZE);
  const packages = [];
  let preCodeTotal = 0;
  for (let p = 0; p < numPackages; p++) {
    const group = sorted.slice(p * PACKAGE_SIZE, p * PACKAGE_SIZE + PACKAGE_SIZE);
    const subtotal = group.reduce((s, it) => s + Math.round(Number(it.price) * 100) / 100, 0);
    const preCode = Math.round(subtotal * (1 - PACKAGE_DISCOUNT) * 100) / 100;
    const total = Math.round(preCode * (1 - pct) * 100) / 100;
    preCodeTotal += preCode;
    // baseAmounts: la parte de cada foto ANTES del código (después del
    // descuento por volumen). Es la base del reparto con cupón de
    // recompensa: el fotógrafo cobra como si no hubiera cupón.
    packages.push({ photoIds: group.map(g => g.id), subtotal, discount: Math.round((subtotal - total) * 100) / 100, total, amounts: splitAmount(total, group.length), baseAmounts: splitAmount(preCode, group.length) });
  }
  const singles = sorted.slice(numPackages * PACKAGE_SIZE);
  const lines = singles.map((it, i) => {
    const price = Math.round(Number(it.price) * 100) / 100;
    const discount = singleDiscountForPosition(i + 1);
    const preCode = Math.round(price * (1 - discount) * 100) / 100;
    preCodeTotal += preCode;
    return { id: it.id, price, discount, lineTotal: Math.round(preCode * (1 - pct) * 100) / 100, baseTotal: preCode };
  });
  const subtotal = packages.reduce((s, p) => s + p.subtotal, 0) + lines.reduce((s, l) => s + l.price, 0);
  const total = packages.reduce((s, p) => s + p.total, 0) + lines.reduce((s, l) => s + l.lineTotal, 0);
  const codeDiscount = Math.round((preCodeTotal - total) * 100) / 100;
  return { packages, lines, subtotal, discount: Math.round((subtotal - total) * 100) / 100, total, codePercent: pct * 100, codeDiscount, volumeDiscount: Math.round((subtotal - preCodeTotal) * 100) / 100 };
}

// ---- Códigos de descuento (2026-11-18) ----
// Un código único por corredor, aleatorio (NUNCA en serie: en serie
// cualquiera adivina el código de otro). Formato PREFIX-XXXXXX: PREFIX
// son las 6 primeras letras del nombre del evento en mayúsculas (sin
// acentos ni números; si el nombre tiene menos de 6 letras se completa
// con X) y XXXXXX son 6 caracteres aleatorios sin caracteres que se
// confunden (sin 0/O, 1/I/L). La unicidad se revisa contra la base
// antes de guardar (y el índice único la garantiza si dos generaciones
// corren a la vez).
const DISCOUNT_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DISCOUNT_CODE_SUFFIX_LEN = 6;
const DISCOUNT_CODE_PREFIX_LEN = 6;
function discountCodePrefix(eventName) {
  const letters = String(eventName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, DISCOUNT_CODE_PREFIX_LEN);
  return (letters + 'XXXXXX').slice(0, DISCOUNT_CODE_PREFIX_LEN);
}
function randomDiscountSuffix() {
  const bytes = crypto.randomBytes(DISCOUNT_CODE_SUFFIX_LEN);
  let out = '';
  for (let i = 0; i < DISCOUNT_CODE_SUFFIX_LEN; i++) out += DISCOUNT_CODE_CHARS[bytes[i] % DISCOUNT_CODE_CHARS.length];
  return out;
}
function makeDiscountCode(eventName) { return discountCodePrefix(eventName) + '-' + randomDiscountSuffix(); }
function validDiscountPercent(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < 1 || r > 100) return null;
  return r;
}
// Usos por código (multiuso): cuántas veces se puede usar en total.
// 1 = un solo uso (como antes). 2-1000 = código compartido.
function validMaxUses(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  const r = Math.floor(n);
  if (r < 1 || r > 1000) return null;
  return r;
}
// Genera un código único para el evento: reintenta si choca con uno que
// ya existe (con 32^6 combinaciones por prefijo, el choque es casi
// imposible; el reintento es por si dos generaciones corren a la vez).
async function generateUniqueDiscountCode(store, eventName) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = makeDiscountCode(eventName);
    const exists = typeof store.getDiscountCodeByCode === 'function' ? await store.getDiscountCodeByCode(code).catch(() => null) : null;
    if (!exists) return code;
  }
  throw err(500, 'No se pudo generar un código único. Inténtalo de nuevo.');
}
function publicDiscountCode(c) {
  return c ? { id: c.id, code: c.code, eventId: c.eventId != null ? c.eventId : null, discountPercent: c.discountPercent, note: c.note || '', used: !!c.used, usedBy: c.usedBy != null ? c.usedBy : null, usedAt: c.usedAt || null, active: c.active !== false, maxUses: Number(c.maxUses || 1), uses: Number(c.uses || 0), isReward: !!c.isReward, rewardKind: c.rewardKind || null, createdAt: c.createdAt || null } : null;
}
// Valida un código para un evento y devuelve la fila. Errores claros
// para que el corredor sepa qué pasó (no existe / otro evento /
// agotado / desactivado / ya lo usó esta cuenta). Sin tabla en la base
// (falta correr el SQL), el código no se encuentra y se dice que no
// existe. userId es opcional: sin él no se revisa el uso por cuenta
// (solo el tope total).
async function validateDiscountCodeRow(store, rawCode, eventId, userId) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) throw err(400, 'Escribe tu código de descuento.');
  const row = typeof store.getDiscountCodeByCode === 'function' ? await store.getDiscountCodeByCode(code).catch(() => null) : null;
  if (!row) throw err(404, 'Ese código no existe. Revísalo y escríbelo de nuevo.');
  if (row.active === false) throw err(400, 'Ese código ya no está activo.');
  const maxUses = Number(row.maxUses || 1);
  const uses = Number(row.uses || 0);
  if (row.used || uses >= maxUses) throw err(400, maxUses > 1 ? 'Ese código ya se acabó.' : 'Ese código ya se usó.');
  // Cupón de recompensa (eventId NULL): vale para CUALQUIER evento.
  if (row.eventId != null && Number(row.eventId) !== Number(eventId)) {
    const ev = await store.getEvent(row.eventId).catch(() => null);
    throw err(400, 'Ese código es solo para fotos de ' + (ev ? ev.name : 'otro evento') + '.');
  }
  if (userId != null && typeof store.hasDiscountCodeRedemption === 'function') {
    const already = await store.hasDiscountCodeRedemption(row.id, Number(userId)).catch(() => false);
    if (already) throw err(400, 'Ya usaste este código.');
  }
  return row;
}
// Marca el canje del checkout cuando el pago se confirma. No rompe
// nunca el pago: si falla, solo se registra en el log.
// Camino nuevo (multiuso): el checkout lleva el código en sus pagos
// (discountCodeId), así muchos checkouts del mismo código compartido
// no se pisan entre sí; el canje registra el uso de ESTA cuenta y suma
// 1, y apaga el código al llegar al tope. Camino viejo: checkouts
// creados antes de este cambio, atados por payment_request_id en la
// fila del código (un solo uso).
async function markDiscountCodeUsedForCheckout(store, clipId, userId) {
  try {
    if (typeof store.redeemDiscountCode === 'function' && typeof store.getPaymentsByClipId === 'function') {
      const pays = await store.getPaymentsByClipId(String(clipId)).catch(() => []);
      const withCode = (pays || []).find(p => p.discountCodeId != null);
      if (withCode) return await store.redeemDiscountCode(Number(withCode.discountCodeId), Number(userId), String(clipId));
    }
    if (typeof store.markDiscountCodeUsedByClipId !== 'function') return null;
    return await store.markDiscountCodeUsedByClipId(String(clipId), Number(userId));
  } catch (e) {
    console.error('[codigos] no se pudo marcar el código del checkout ' + clipId + ': ' + (e.message || e));
    return null;
  }
}

// POST /api/validate-discount-code { code, eventId } — el corredor
// comprueba su código antes de pagar. No marca nada como usado.
async function validateDiscountCode(store, user, body) {
  requireUser(user);
  const eventId = Number(body.eventId);
  if (!eventId) throw err(400, 'Falta el evento del código.');
  const row = await validateDiscountCodeRow(store, body.code, eventId, user.id);
  const maxUses = Number(row.maxUses || 1);
  return { status: 200, data: { valid: true, code: row.code, eventId: row.eventId, discountPercent: row.discountPercent, maxUses, usesLeft: Math.max(0, maxUses - Number(row.uses || 0)) } };
}

// POST /api/create-discount-code { eventId, discountPercent?, note?, maxUses? } —
// un solo código (para regalar a una persona, o un código compartido
// con tope de usos). Solo el dueño.
async function createDiscountCode(store, user, body) {
  requireOwner(user);
  const ev = await store.getEvent(Number(body.eventId));
  if (!ev) throw err(404, 'Evento no encontrado.');
  const pct = validDiscountPercent(body.discountPercent == null ? 20 : body.discountPercent);
  if (pct == null) throw err(400, 'El descuento debe ser entre 1% y 100%.');
  const maxUses = validMaxUses(body.maxUses == null ? 1 : body.maxUses);
  if (maxUses == null) throw err(400, 'Los usos por código deben ser entre 1 y 1000.');
  const note = String(body.note || '').trim().slice(0, 120);
  const code = await generateUniqueDiscountCode(store, ev.name);
  let row;
  try {
    row = await store.createDiscountCode({ code, eventId: ev.id, discountPercent: pct, note, maxUses, createdBy: user.id });
  } catch (e) {
    // Carrera con otra generación a la vez (índice único): reintentar
    // una vez con otro código.
    if (/unique|duplicate/i.test(e.message || '')) {
      const code2 = await generateUniqueDiscountCode(store, ev.name);
      row = await store.createDiscountCode({ code: code2, eventId: ev.id, discountPercent: pct, note, maxUses, createdBy: user.id });
    } else throw e;
  }
  return { status: 201, data: { code: publicDiscountCode(row) } };
}

// POST /api/generate-discount-codes { eventId, quantity, discountPercent?, maxUses? }
// — genera N códigos de golpe (para dárselos a un organizador: 500-800
// corredores). Solo el dueño. quantity 1-1000. maxUses es por código
// (1 = un solo uso, como antes; N = cada código se puede usar N veces,
// una por cuenta).
async function generateDiscountCodes(store, user, body) {
  requireOwner(user);
  const ev = await store.getEvent(Number(body.eventId));
  if (!ev) throw err(404, 'Evento no encontrado.');
  const qty = Math.floor(Number(body.quantity));
  if (!Number.isFinite(qty) || qty < 1 || qty > 1000) throw err(400, 'La cantidad debe ser entre 1 y 1000 códigos.');
  const pct = validDiscountPercent(body.discountPercent == null ? 20 : body.discountPercent);
  if (pct == null) throw err(400, 'El descuento debe ser entre 1% y 100%.');
  const maxUses = validMaxUses(body.maxUses == null ? 1 : body.maxUses);
  if (maxUses == null) throw err(400, 'Los usos por código deben ser entre 1 y 1000.');
  // Unicidad sin N consultas: se cargan los códigos que ya existen una
  // sola vez y se generan los nuevos fuera de ese conjunto. El índice
  // único de la base sigue siendo el respaldo si dos generaciones
  // corren a la vez (ese choque se reintenta código por código).
  const existing = new Set((await store.listDiscountCodes().catch(() => [])).map(c => String(c.code || '').toUpperCase()));
  const codes = [];
  let guard = 0;
  while (codes.length < qty && guard++ < qty * 50) {
    const code = makeDiscountCode(ev.name);
    if (!existing.has(code) && !codes.includes(code)) { codes.push(code); existing.add(code); }
  }
  if (codes.length < qty) throw err(500, 'No se pudieron generar ' + qty + ' códigos únicos. Inténtalo con menos.');
  const payload = codes.map(code => ({ code, eventId: ev.id, discountPercent: pct, note: '', maxUses, createdBy: user.id }));
  let rows;
  try {
    rows = typeof store.createDiscountCodes === 'function'
      ? await store.createDiscountCodes(payload)
      : await (async () => { const out = []; for (const p of payload) out.push(await store.createDiscountCode(p)); return out; })();
  } catch (e) {
    if (!/unique|duplicate/i.test(e.message || '')) throw e;
    // Choque con una generación paralela: reintentar código por código.
    rows = [];
    for (const code of codes) {
      try {
        rows.push(await store.createDiscountCode({ code, eventId: ev.id, discountPercent: pct, note: '', maxUses, createdBy: user.id }));
      } catch (e2) {
        if (!/unique|duplicate/i.test(e2.message || '')) throw e2;
        const alt = await generateUniqueDiscountCode(store, ev.name);
        rows.push(await store.createDiscountCode({ code: alt, eventId: ev.id, discountPercent: pct, note: '', maxUses, createdBy: user.id }));
      }
    }
  }
  return { status: 201, data: { eventId: ev.id, discountPercent: pct, maxUses, count: rows.length, codes: rows.map(publicDiscountCode) } };
}

// POST /api/list-discount-codes { eventId? } — solo el dueño. Con
// eventId filtra; sin él devuelve todos (para revisar).
async function listDiscountCodes(store, user, body) {
  requireOwner(user);
  const eventId = body.eventId != null ? Number(body.eventId) : null;
  const rows = await store.listDiscountCodes(eventId).catch(() => []);
  const out = [];
  for (const c of rows) {
    const pub = publicDiscountCode(c);
    if (c.used && c.usedBy != null) {
      const u = await store.findUserById(c.usedBy).catch(() => null);
      pub.usedByName = u ? (u.name || '') : '';
    } else pub.usedByName = '';
    out.push(pub);
  }
  return { status: 200, data: { codes: out } };
}

// POST /api/deactivate-discount-code { codeId } — solo el dueño. Un
// código agotado (usado) ya no se puede desactivar; uno con usos
// parciales (ej. 3/50) sí: se apaga y los usos que quedaban se pierden.
async function deactivateDiscountCode(store, user, body) {
  requireOwner(user);
  const row = typeof store.getDiscountCodeById === 'function'
    ? await store.getDiscountCodeById(Number(body.codeId)).catch(() => null)
    : (await store.listDiscountCodes().catch(() => [])).find(c => c.id === Number(body.codeId)) || null;
  if (!row) throw err(404, 'Código no encontrado.');
  if (row.used) throw err(400, 'Ese código ya se usó, no se puede desactivar.');
  if (row.active === false) return { status: 200, data: { code: publicDiscountCode(row) } };
  const updated = await store.updateDiscountCode(row.id, { active: false });
  return { status: 200, data: { code: publicDiscountCode(updated) } };
}

// Referencia externa de Clip (metadata.external_reference): máx 36
// caracteres. Sirve para atar el regreso desde Clip con nuestro pago.
function makeExternalRef(photoId, userId) {
  return ('OC-' + photoId + '-' + userId + '-' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex')).slice(0, 36);
}

// Referencia de una fila del carrito: lleva el índice dentro del carrito
// para que dos filas del mismo checkout nunca choquen aunque se creen en
// el mismo milisegundo. La primera fila lleva la referencia del regreso
// desde Clip (metadata.external_reference y ?ref=...).
function makeCartRef(userId, index) {
  return ('OC-C' + userId + '-' + index + '-' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex')).slice(0, 36);
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
// ya estaba pagado o ya tenía la descarga, no duplica nada). Si la venta
// es sin comisión (el fotógrafo tenía banco), se descuenta UNA del
// banco aquí y la descarga y el pago quedan marcados commissionFree;
// si la descarga ya existía (re-verificación o reactivación de una
// quitada), se conserva su marca y NO se vuelve a gastar el banco.
async function markPaymentPaid(store, payment, clipData) {
  const already = await store.hasDownload(payment.userId, payment.photoId);
  let commissionFree = false;
  if (!already) {
    const existing = await store.getDownloadByUserPhoto(payment.userId, payment.photoId).catch(() => null);
    commissionFree = existing ? !!existing.commissionFree : await maybeApplyFreeSale(store, payment);
    await store.addDownload({ userId: payment.userId, photoId: payment.photoId, eventId: payment.eventId, amount: payment.amount, baseAmount: payment.baseAmount != null ? payment.baseAmount : null, commissionFree });
  } else {
    const existing = await store.getDownloadByUserPhoto(payment.userId, payment.photoId).catch(() => null);
    commissionFree = !!(existing && existing.commissionFree);
  }
  if (payment.status !== 'completed') {
    await store.updatePaymentStatus(payment.id, { status: 'completed', receiptNo: (clipData && clipData.receipt_no) || payment.receiptNo || '', commissionFree });
  }
  return { already, commissionFree };
}

// Vuelve a consultar el estado real en Clip y actualiza TODAS las filas
// que comparten un payment_request_id (una foto suelta = una fila; un
// carrito = una fila por foto). Es el único lugar donde se decide si algo
// está pagado: ni el webhook ni la redirección del navegador son prueba
// de pago por sí solos. Se consulta a Clip UNA sola vez por checkout.
// Aviso por correo cuando se VENDE una foto (solo ventas con pago, nunca
// descargas gratis: esas no crean filas de pago y nunca llegan aquí).
// Se manda UNA vez por pedido: solo por las fotos que en ESTA llamada
// pasaron a pagadas (markPaymentPaid dice already=true si la descarga ya
// existía, y entonces no se vuelve a avisar aunque Clip reintente el
// webhook o el comprador re-consulte el estado). Si el correo falla o
// tarda, el webhook no se rompe: se espera máximo 4 s y se sigue.
async function notifySale(store, newlyPaid) {
  const byPhotographer = new Map();
  for (const p of newlyPaid) {
    const photo = await store.getPhoto(p.photoId);
    const ev = photo ? await store.getEvent(photo.eventId || p.eventId) : await store.getEvent(p.eventId);
    const ownerId = photoOwnerId(photo, ev);
    if (ownerId == null) continue;
    if (!byPhotographer.has(ownerId)) byPhotographer.set(ownerId, []);
    byPhotographer.get(ownerId).push({ payment: p, photo, event: ev });
  }
  if (!byPhotographer.size) return;
  // El aviso va SOLO al fotógrafo que vendió. Si vende Orlan, él es el
  // fotógrafo y recibe este mismo correo; si vende otro, a Orlan no le
  // llega nada (lo ve en su panel).
  const buyer = newlyPaid[0] ? await store.findUserById(newlyPaid[0].userId) : null;
  const buyerFirst = buyer && buyer.name ? String(buyer.name).split(' ')[0] : '';
  for (const [photographerId, items] of byPhotographer) {
    const ph = await store.findUserById(photographerId);
    if (!ph || !ph.email) continue;
    const total = items.reduce((s, it) => s + Number(it.payment.amount || 0), 0);
    // Con cupón de recompensa el fotógrafo cobra sobre el precio SIN
    // descuento (splitDownload): el correo le muestra lo que REALMENTE
    // le toca, no el total pagado.
    const share = items.reduce((s, it) => s + splitDownload({ amount: it.payment.amount, baseAmount: it.payment.baseAmount, commissionFree: !!it.payment.commissionFree }).photographerShare, 0);
    const freeCount = items.filter(it => it.payment.commissionFree).length;
    const lines = items.map(it => {
      const bib = (it.photo && it.photo.bibs && it.photo.bibs[0]) || '';
      return `• ${it.event ? it.event.name : 'Evento'} — foto${bib ? ' dorsal ' + bib : ''} — $${Number(it.payment.amount).toFixed(2)} MXN`;
    }).join('\n');
    const n = items.length;
    await sendSaleEmail({
      to: ph.email,
      subject: `¡Vendiste ${n === 1 ? 'una foto' : n + ' fotos'} en OnlyClick! $${total.toFixed(2)} MXN`,
      text: `Hola ${displayNameFor(ph)},\n\n¡Vendiste ${n === 1 ? 'una foto' : n + ' fotos'} en OnlyClick!${buyerFirst ? ` La compró ${buyerFirst}.` : ''}\n\n${lines}\n\nTotal: $${total.toFixed(2)} MXN — tu parte: $${share.toFixed(2)} MXN (${freeCount === n ? 'sin comisión de OnlyClick en esta venta: es una de tus ventas sin comisión 🎉' : freeCount > 0 ? 'incluye ' + freeCount + ' venta(s) sin comisión de OnlyClick 🎉; el resto, después de la comisión de Clip y el 10% de OnlyClick' : 'después de la comisión de Clip y el 10% de OnlyClick'}). OnlyClick te lo manda a tu CLABE en máximo 72 horas.\n\nPuedes verlo en tu panel de fotógrafo.`,
    });
  }
}

// Aviso al COMPRADOR cuando su pago se confirma (Orlan, 2026-11-19):
// le llega a su campanita que ya puede descargar sus fotos. Es lo que
// necesita el que pagó en efectivo y esperó hasta 48 h: sin esto, solo
// se enteraba entrando a "Mis fotos".
// Se crea UN aviso por comprador y evento: solo con las filas que en
// ESTA llamada pasaron a pagadas (newlyPaid), así un reintento del
// webhook o un segundo "Verificar pago" no duplica el aviso. Si crear
// el aviso falla, el pago no se rompe: se registra y se sigue.
async function notifyBuyer(store, newlyPaid) {
  const byBuyerEvent = new Map();
  for (const p of newlyPaid) {
    const ev = await store.getEvent(p.eventId).catch(() => null);
    const key = p.userId + ':' + (ev ? ev.id : p.eventId);
    if (!byBuyerEvent.has(key)) byBuyerEvent.set(key, { userId: p.userId, event: ev, eventId: p.eventId, count: 0 });
    byBuyerEvent.get(key).count++;
  }
  for (const g of byBuyerEvent.values()) {
    const n = g.count;
    const eventName = g.event ? g.event.name : 'el evento';
    const title = '¡Tu pago se confirmó!';
    const body = n === 1
      ? 'Ya puedes descargar tu foto de ' + eventName + '. Está en Mis fotos.'
      : 'Ya puedes descargar tus ' + n + ' fotos de ' + eventName + '. Están en Mis fotos.';
    try { await store.createAnnouncement({ title, body, userId: g.userId, createdBy: null }); }
    catch (e) { console.error('[aviso-pago] no se pudo avisar al comprador ' + g.userId + ': ' + (e.message || e)); }
  }
}

async function refreshPaymentsByClipId(store, clipId) {
  const payments = await store.getPaymentsByClipId(clipId);
  if (!payments.length) return { clip: null, payments, paid: false };
  const cur = await clip.getCheckout(clipId);
  const status = clipStatusToPayment(cur.status);
  if (status === 'completed') {
    const newlyPaid = [];
    for (const p of payments) {
      const r = await markPaymentPaid(store, p, cur);
      if (!r.already) { p.commissionFree = r.commissionFree; newlyPaid.push(p); }
    }
    if (newlyPaid.length) {
      // Avisos (nunca rompen el pago): al fotógrafo por correo y al
      // comprador a su campanita. Máximo 4 s entre los dos.
      try { await Promise.race([Promise.allSettled([notifySale(store, newlyPaid), notifyBuyer(store, newlyPaid)]), new Promise(r => setTimeout(r, 4000))]); } catch (_) { /* el aviso nunca rompe el pago */ }
      // Recompensas de fotógrafos (2026-11-20): cada venta confirmada
      // puede completar un hito (50 fotos) del que vendió, o la
      // primera venta de un fotógrafo referido (que da la estrella a
      // quien lo invitó). Se otorgan aquí (y al abrir Recompensas);
      // nunca rompen el pago.
      try {
        const owners = new Set();
        for (const p of newlyPaid) {
          const photo = await store.getPhoto(p.photoId).catch(() => null);
          const ev = photo ? await store.getEvent(photo.eventId || p.eventId).catch(() => null) : null;
          const ownerId = photoOwnerId(photo, ev);
          if (ownerId != null) {
            owners.add(ownerId);
            const ownerUser = await store.findUserById(ownerId).catch(() => null);
            if (ownerUser && ownerUser.referredBy != null) owners.add(Number(ownerUser.referredBy));
          }
        }
        await Promise.allSettled([...owners].map(id => maybeGrantPhotographerRewards(store, id)));
      } catch (_) {}
    }
    // El código de descuento se quema SOLO ahora que el pago se confirmó
    // (idempotente: si ya estaba usado, no hace nada). Un pago fallido o
    // vencido nunca llega aquí, así que no quema el código. Cubre el
    // webhook, "Verificar pago" y el regreso desde Clip: todos pasan por
    // aquí.
    await markDiscountCodeUsedForCheckout(store, clipId, payments[0].userId);
    return { clip: cur, payments: await store.getPaymentsByClipId(clipId), paid: true };
  }
  for (const p of payments) {
    if (p.status !== status) await store.updatePaymentStatus(p.id, { status });
  }
  return { clip: cur, payments: await store.getPaymentsByClipId(clipId), paid: false };
}

// Versión de una sola fila (flujo de una foto): delega en la de grupo.
async function refreshPaymentFromClip(store, payment) {
  const r = await refreshPaymentsByClipId(store, payment.clipPaymentRequestId);
  const mine = r.payments.find(p => p.id === payment.id) || payment;
  return { clip: r.clip, payment: mine, paid: r.paid };
}

// ---- Pago en efectivo en tiendas (OXXO, 7-Eleven y más) — DESBLOQUEADO
// 2026-11-19 ----
// Orlan lo había bloqueado el 2026-11-18 porque el cobro de $50 del
// 2026-11-17 (checkout 10TIJ5OJGK) seguía sin reflejarse y no le gusta
// esperar. El 2026-11-19 se supo que Clip SÍ lo había confirmado el
// mismo martes en la noche (recibo #PAufAwcr; en OnlyClick quedó
// marcado como pagado y con las descargas liberadas). Orlan decidió
// desbloquearlo con un aviso claro: el pago en efectivo tarda hasta
// 48 horas en confirmarse. La pantalla de pago lo dice así.
// El cobro de $50 YA CREADO no se cancela: sigue pendiente y se confirma
// por webhook o con "Verificar pago" (checkout-status) igual que antes;
// nada de eso se toca aquí.
// El efectivo funciona así: basta pedir payment_method_types
// ["credit", "debit", "cash"] en custom_payment_options. El comprador
// elige "Efectivo" en la página de Clip, recibe su referencia y paga
// en OXXO, 7-Eleven o cualquiera de las tiendas que le muestre Clip;
// Clip avisa por webhook y el cobro se confirma igual que con tarjeta
// (el GET /v2/checkout no dice cómo se pagó, y no hace falta: la
// entrega es la misma). Comisión igual: 3.6% + IVA. SPEI está
// desactivado por Clip por ahora ("temporalmente desactivado" en su
// centro de ayuda), así que no se ofrece.
// La referencia vivía lo que vive el link: se ponía expires_at a 7 días
// (el default de Clip son 72 h) para que el corredor alcanzara a ir a
// la tienda.
// BUG 2026-11-17 (en vivo, no solo en la doc): Clip rechazaba TODOS los
// cobros con 400 "Invalid input" (lo vio Orlan en su teléfono, foto y
// carrito). La primera hipótesis fue expires_at con milisegundos (la doc
// oficial exige YYYY-MM-DDTHH:MM:SSZ sin milisegundos, y eso se
// arregló), pero NO era todo: los logs de Vercel del 2026-11-17 a las
// 19:06 y 19:09 muestran el error real de Clip al crear el checkout
// del carrito:
// {"message":"Invalid input","code_message":"002","detail":"Invalid option
// in payment_method_types, allowed values are
// credit|debit|cash|bank_transfer|wallet"}.
// "card" NO es un valor válido en la API en vivo, aunque la doc
// (developer.clip.mx ?page=cnp-mxn) lo sugiera: la API en vivo manda.
// Por eso ahora se manda ["credit", "debit", "cash"] (tarjeta +
// efectivo). El cobro del OXXO del 2026-11-17 ($50, checkout
// 10TIJ5OJGK) salió gracias al intento 3 (payload mínimo, sin
// custom_payment_options): era el fallback que salvaba el cobro si
// Clip volvía a rechazar un campo opcional. El intento 3 sigue
// llevando custom_payment_options con los mismos tipos, solo sin
// expires_at (así el listado de métodos queda explícito).
// expires_at en el formato EXACTO de la doc (sin milisegundos).
function clipExpiresAt() { return new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
// ¿Es un 400 de Clip? clipRequest pone e.clipStatus = status; el mensaje
// siempre es "Clip (400): ...". Solo un 400 dispara reintentos (un 401,
// 500 o fallo de red se lanza tal cual).
function isClip400(e) { return !!e && (e.clipStatus === 400 || /Clip \(400\)/.test(String(e.message || ''))); }
// Crea el link de Clip con cadena de reintentos: (1) completo (tarjeta +
// efectivo + expires_at en formato de la doc); (2) sin expires_at;
// (3) mismos tipos, sin expires_at. Así el cobro nunca se rompe por un
// campo opcional. Cada reintento se registra en el log del servidor.
async function createClipLink(opts) {
  const payMethods = { payment_method_types: ['credit', 'debit', 'cash'] };
  const attempts = [
    { ...opts, custom_payment_options: payMethods, expires_at: clipExpiresAt() },
    { ...opts, custom_payment_options: payMethods },
    { ...opts, custom_payment_options: payMethods },
  ];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try { return await clip.createCheckoutLink(attempts[i]); }
    catch (e) {
      lastErr = e;
      if (!isClip400(e) || i === attempts.length - 1) throw e;
      console.error('[clip] createCheckout intento ' + (i + 1) + ' rechazado (400): ' + (e.message || e) + ' — reintentando con menos campos opcionales');
    }
  }
  throw lastErr;
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
  // No se cobra una foto de un álbum oculto (salvo al dueño).
  assertEventVisible(user, ev);
  // Ni de un álbum "Próximo evento" (salvo al dueño): la foto no se
  // podría descargar después de pagar.
  if (ev.isUpcoming && !(user && user.isOwner)) throw err(404, 'Este álbum aún no tiene fotos. Las fotos estarán disponibles después de la carrera.');
  if (ev.freeMode) throw err(400, 'Ese evento es gratis, no se cobra.');
  if (user.role === 'photographer' && photoOwnerId(photo, ev) === user.id) throw err(400, 'No puedes comprar tus propias fotos.');
  if (await store.hasDownload(user.id, photo.id)) return { status: 200, data: { paid: true, photoId: photo.id } };
  const price = await photoPrice(store, photo, ev);
  // Código de descuento (opcional): se valida contra ESTE evento y se
  // aplica sobre el precio por foto, en centavos. Un código de 100% no
  // se puede cobrar (Clip no cobra $0): se avisa claro.
  let discountRow = null;
  let amount = price;
  let codeDiscount = 0;
  const rawCode = String(body.code || '').trim();
  if (rawCode) {
    discountRow = await validateDiscountCodeRow(store, rawCode, ev.id, user.id);
    codeDiscount = Math.round(price * (Number(discountRow.discountPercent) / 100) * 100) / 100;
    amount = Math.round((price - codeDiscount) * 100) / 100;
    if (amount <= 0) throw err(400, 'Ese código deja la foto en $0 y no se puede cobrar. Pídele a Orlan un código con menos descuento.');
  }
  // Reutilizar un link pendiente vigente para no crear links de más.
  // Con código: solo si el pendiente ya lleva EL MISMO monto con
  // descuento (si se creó sin código, su monto es otro y se crea un link
  // nuevo; el pendiente viejo vence solo).
  const pending = await store.getLatestPaymentByUserPhoto(user.id, photo.id);
  if (pending && pending.status === 'pending' && pending.clipPaymentRequestId) {
    try {
      const cur = await clip.getCheckout(pending.clipPaymentRequestId);
      if (cur && (cur.status === 'CHECKOUT_CREATED' || cur.status === 'CHECKOUT_PENDING') && Number(pending.amount) === amount) {
        return { status: 200, data: { checkoutUrl: cur.payment_request_url, paymentRequestId: cur.payment_request_id, amount: pending.amount, discountCode: discountRow ? discountRow.code : null, codeDiscount } };
      }
      await store.updatePaymentStatus(pending.id, { status: clipStatusToPayment(cur.status) });
    } catch (_) { /* si Clip falla al consultar, se crea un link nuevo */ }
  }
  const ref = makeExternalRef(photo.id, user.id);
  const base = publicBase();
  const created = await createClipLink({
    amount,
    currency: 'MXN',
    purchase_description: ('Foto OnlyClick — ' + ev.name + ' — ' + displayNameFor(await store.findUserById(photoOwnerId(photo, ev))) + ' — dorsal ' + ((photo.bibs || []).join(', ') || 'sin dorsal')).slice(0, 255),
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
    amount, currency: 'MXN', status: 'pending',
    // Cupón de recompensa: se guarda el precio SIN descuento para que
    // el reparto le pague al fotógrafo como si no hubiera cupón.
    baseAmount: discountRow && discountRow.eventId == null ? price : null,
    discountCodeId: discountRow ? discountRow.id : null,
  });
  // Atar el checkout al código (sin quemarlo todavía: solo se marca
  // usado cuando Clip confirme el pago, en refreshPaymentsByClipId).
  if (discountRow) {
    try { await store.setDiscountCodePaymentRequest(discountRow.id, created.payment_request_id); } catch (_) {}
  }
  return { status: 200, data: { checkoutUrl: created.payment_request_url, paymentRequestId: created.payment_request_id, paymentId: payment.id, amount, price, discountCode: discountRow ? discountRow.code : null, codeDiscount } };
}

// POST /api/checkout-create-cart { photoIds: [...] } — crea UN solo link
// de pago de Clip para todo el carrito, con los descuentos por volumen.
// El total se calcula EN EL SERVIDOR desde events.price_mxn: lo que el
// cliente manda (solo los ids) nunca decide el monto. Se guarda UNA fila
// en payments por cada foto, todas con el mismo payment_request_id.
async function createCartCheckout(store, user, body) {
  requireUser(user);
  const ids = [...new Set((Array.isArray(body.photoIds) ? body.photoIds : []).map(Number).filter(Boolean))];
  if (!ids.length) throw err(400, 'El carrito está vacío.');
  if (ids.length > CART_MAX_ITEMS) throw err(400, 'El carrito no puede tener más de ' + CART_MAX_ITEMS + ' fotos.');
  // Precios desde la base, foto por foto.
  const items = [];
  for (const id of ids) {
    const photo = await store.getPhoto(id);
    if (!photo) throw err(404, 'Foto no encontrada: ' + id + '.');
    const ev = await store.getEvent(photo.eventId);
    if (!ev) throw err(404, 'Evento no encontrado.');
    // No se cobra una foto de un álbum oculto (salvo al dueño).
    assertEventVisible(user, ev);
    // Ni de un álbum "Próximo evento" (salvo al dueño): la foto no se
    // podría descargar después de pagar.
    if (ev.isUpcoming && !(user && user.isOwner)) throw err(404, 'Este álbum aún no tiene fotos. Las fotos estarán disponibles después de la carrera.');
    if (ev.freeMode) throw err(400, 'La foto ' + id + ' es de un evento gratis: quítala del carrito y descárgala gratis.');
    // Un fotógrafo no puede comprar sus PROPIAS fotos; las de otros
    // fotógrafos sí las puede comprar como cualquier corredor.
    if (user.role === 'photographer' && photoOwnerId(photo, ev) === user.id) throw err(400, 'La foto ' + id + ' es tuya: no puedes comprar tus propias fotos. Quítala del carrito.');
    items.push({ id: photo.id, eventId: ev.id, eventName: ev.name, bibs: photo.bibs || [], price: await photoPrice(store, photo, ev) });
  }
  // Fotos ya compradas: se excluyen del cobro, no se cobran dos veces.
  const toPay = [];
  const alreadyPaid = [];
  for (const it of items) {
    if (await store.hasDownload(user.id, it.id)) alreadyPaid.push(it.id);
    else toPay.push(it);
  }
  if (!toPay.length) return { status: 200, data: { paid: true, photoIds: alreadyPaid, amount: 0 } };
  // Código de descuento (opcional): debe ser del evento de TODAS las
  // fotos del carrito (un código es por evento) — EXCEPTO los cupones de
  // recompensa (eventId NULL), que valen para CUALQUIER evento y hasta
  // mezclan eventos. Se aplica DESPUÉS de los descuentos por volumen,
  // sobre el total final (cartTotals lo reparte por paquete y por línea,
  // así las filas de pago suman el total con descuento). Un código de
  // 100% deja el total en $0 y el chequeo de abajo lo rechaza con el
  // mensaje de siempre.
  // UN SOLO CÓDIGO POR CARRITO (regla de Orlan 2026-11-20): el carrito
  // acepta un único código; si el usuario tiene dos cupones de 10%
  // (agradecimiento + referido), usa uno por compra y el otro queda
  // vigente para la siguiente.
  let discountRow = null;
  const rawCode = String(body.code || '').trim();
  if (rawCode) {
    const probe = typeof store.getDiscountCodeByCode === 'function' ? await store.getDiscountCodeByCode(rawCode.toUpperCase()).catch(() => null) : null;
    if (!(probe && probe.eventId == null)) {
      const eventIds = [...new Set(toPay.map(t => Number(t.eventId)))];
      if (eventIds.length !== 1) throw err(400, 'El código es solo para las fotos de un evento. Quita las fotos de otros eventos o paga por separado.');
    }
    discountRow = await validateDiscountCodeRow(store, rawCode, toPay[0].eventId, user.id);
  }
  const totals = cartTotals(toPay.map(t => ({ id: t.id, price: t.price })), discountRow ? Number(discountRow.discountPercent) : 0);
  if (totals.total <= 0) throw err(400, 'El total no es válido.');
  if (totals.total > CART_MAX_TOTAL) throw err(400, 'El total ($' + totals.total + ' MXN) supera el límite de $' + CART_MAX_TOTAL + ' MXN por pago de Clip. Divide tu compra en dos carritos.');
  const base = publicBase();
  const firstRef = makeCartRef(user.id, 0);
  const created = await createClipLink({
    amount: totals.total,
    currency: 'MXN',
    purchase_description: ('OnlyClick: ' + toPay.length + (toPay.length === 1 ? ' foto' : ' fotos')).slice(0, 255),
    redirection_url: {
      success: base + '/api/checkout-return?ref=' + encodeURIComponent(firstRef) + '&cart=1',
      error: base + '/api/checkout-return?ref=' + encodeURIComponent(firstRef) + '&cart=1&result=error',
      default: base + '/',
    },
    metadata: { external_reference: firstRef, customer_info: { name: user.name, email: user.email } },
    webhook_url: webhookUrl(),
    override_settings: { locale: 'es-MX', tip_enabled: false },
  });
  // Una fila por foto, todas con el mismo payment_request_id. Las fotos
  // de un paquete llevan su parte del total del paquete (reparto exacto);
  // las individuales llevan su precio con su descuento.
  const rows = [];
  let refIndex = 0;
  const addRow = async (photoId, amount, baseAmount) => {
    const it = toPay.find(t => t.id === photoId);
    rows.push(await store.createPayment({
      clipPaymentRequestId: created.payment_request_id,
      // La primera fila lleva la referencia del regreso desde Clip; las
      // demás llevan su propio índice para no chocar entre sí.
      externalReference: refIndex === 0 ? firstRef : makeCartRef(user.id, refIndex),
      userId: user.id, photoId, eventId: it.eventId,
      amount, currency: 'MXN', status: 'pending',
      // Cupón de recompensa: se guarda el precio SIN descuento para
      // que el reparto le pague al fotógrafo como si no hubiera cupón.
      baseAmount: discountRow && discountRow.eventId == null ? baseAmount : null,
      discountCodeId: discountRow ? discountRow.id : null,
    }));
    refIndex++;
  };
  for (const pkg of totals.packages) {
    for (let i = 0; i < pkg.photoIds.length; i++) await addRow(pkg.photoIds[i], pkg.amounts[i], pkg.baseAmounts[i]);
  }
  for (const line of totals.lines) await addRow(line.id, line.lineTotal, line.baseTotal);
  // Atar el checkout al código (sin quemarlo todavía: solo se marca
  // usado cuando Clip confirme el pago, en refreshPaymentsByClipId).
  if (discountRow) {
    try { await store.setDiscountCodePaymentRequest(discountRow.id, created.payment_request_id); } catch (_) {}
  }
  return { status: 200, data: { checkoutUrl: created.payment_request_url, paymentRequestId: created.payment_request_id, paymentIds: rows.map(r => r.id), amount: totals.total, subtotal: totals.subtotal, discount: totals.discount, codeDiscount: totals.codeDiscount, codePercent: totals.codePercent, discountCode: discountRow ? discountRow.code : null, photoIds: toPay.map(t => t.id), alreadyPaid, packages: totals.packages, lines: totals.lines } };
}

// GET /api/checkout-return?ref=...&photoId=... — Clip redirige aquí
// después del pago. Verifica con Clip y redirige (302) al corredor.
// NO requiere sesión: la verificación es contra Clip, no contra el token.
async function checkoutReturn(store, query) {
  const ref = String(query.ref || '');
  const pid = String(query.pid || '');
  const photoId = Number(query.photoId || 0);
  const isCart = String(query.cart || '') === '1';
  const base = publicBase();
  let payment = null;
  if (ref) payment = await store.getPaymentByExternalRef(ref);
  if (!payment && pid) {
    const rows = await store.getPaymentsByClipId(pid);
    payment = rows[0] || null;
  }
  if (!payment) return { status: 302, redirect: base + '/?pay=error', data: {} };
  // Regreso de un carrito: se verifica TODO el checkout (todas sus
  // fotos) y se vuelve a la vista del carrito con el pid para que el
  // frontend lo re-consulte y limpie el carrito al confirmarse.
  if (isCart) {
    const clipId = payment.clipPaymentRequestId;
    const cartBack = base + '/?view=cart&pid=' + encodeURIComponent(clipId);
    try {
      const r = await refreshPaymentsByClipId(store, clipId);
      if (r.paid) return { status: 302, redirect: cartBack + '&paid=1', data: {} };
      const st = r.payments[0] ? r.payments[0].status : 'pending';
      if (st === 'cancelled' || st === 'expired') return { status: 302, redirect: cartBack + '&pay=failed', data: {} };
      return { status: 302, redirect: cartBack + '&pay=pending', data: {} };
    } catch (_) {
      return { status: 302, redirect: cartBack + '&pay=pending', data: {} };
    }
  }
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

// POST /api/checkout-status { paymentRequestId } o { photoId } o
// { photoIds: [...] } — para que el frontend pregunte si un pago
// pendiente ya se confirmó.
//  - paymentRequestId: estado de TODO un checkout (una foto o un carrito
//    completo); devuelve photoIds y count.
//  - photoIds: estado por foto (útil tras pagar un carrito).
//  - photoId: como antes, una sola foto.
async function checkoutStatus(store, user, body) {
  requireUser(user);
  // Carrito (o foto suelta) por payment_request_id.
  if (body.paymentRequestId) {
    const payments = await store.getPaymentsByClipId(String(body.paymentRequestId));
    if (!payments.length) return { status: 200, data: { paid: false, status: 'none' } };
    // Ver el estado: el que pagó, el dueño, o el fotógrafo DE LA FOTO.
    const ev0 = await store.getEvent(payments[0].eventId);
    const ph0 = await store.getPhoto(payments[0].photoId);
    if (payments[0].userId !== user.id && !(await isPhotoOwner(user, ph0, ev0))) throw err(403, 'Ese pago no es tuyo.');
    const photoIds = payments.map(p => p.photoId);
    if (payments.every(p => p.status === 'completed')) return { status: 200, data: { paid: true, status: 'completed', photoIds, count: payments.length, receiptNo: payments[0].receiptNo || '' } };
    if (payments.every(p => p.status === 'cancelled' || p.status === 'expired')) return { status: 200, data: { paid: false, status: payments[0].status, photoIds, count: payments.length } };
    try {
      const r = await refreshPaymentsByClipId(store, String(body.paymentRequestId));
      return { status: 200, data: { paid: r.paid, status: r.payments[0] ? r.payments[0].status : 'pending', photoIds: r.payments.map(p => p.photoId), count: r.payments.length, receiptNo: r.payments[0] ? (r.payments[0].receiptNo || '') : '' } };
    } catch (_) {
      return { status: 200, data: { paid: false, status: payments[0].status, clipError: true, photoIds, count: payments.length } };
    }
  }
  // Estado por foto, para una lista de ids.
  if (Array.isArray(body.photoIds) && body.photoIds.length) {
    const photos = [];
    for (const id of body.photoIds.map(Number).filter(Boolean)) {
      const p = await store.getLatestPaymentByUserPhoto(user.id, id);
      const owned = await store.hasDownload(user.id, id);
      photos.push({ photoId: id, paid: owned || (p && p.status === 'completed'), status: owned ? 'completed' : (p ? p.status : 'none') });
    }
    return { status: 200, data: { paid: photos.length > 0 && photos.every(x => x.paid), photos } };
  }
  // Una foto: como antes.
  let payment = null;
  if (body.photoId) payment = await store.getLatestPaymentByUserPhoto(user.id, Number(body.photoId));
  if (!payment) return { status: 200, data: { paid: false, status: 'none' } };
  const evPay = await store.getEvent(payment.eventId);
  const phPay = await store.getPhoto(payment.photoId);
  if (payment.userId !== user.id && !(await isPhotoOwner(user, phPay, evPay))) throw err(403, 'Ese pago no es tuyo.');
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
  // Un checkout puede cubrir varias fotos (carrito): todas sus filas
  // comparten el payment_request_id y se marcan juntas.
  const payments = await store.getPaymentsByClipId(id);
  if (!payments.length) return { status: 200, data: { ok: true, ignored: 'unknown-payment' } };
  if (payments.every(p => p.status === 'completed')) return { status: 200, data: { ok: true, already: true } };
  try {
    const r = await refreshPaymentsByClipId(store, id);
    return { status: 200, data: { ok: true, paid: r.paid, status: r.payments[0] ? r.payments[0].status : 'pending', photos: r.payments.length } };
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
  // Álbum exclusivo: no tiene precio, las fotos son gratis.
  if (ev.isExclusive) throw err(400, 'Un álbum exclusivo OnlyClick no tiene precio: las fotos son gratis.');
  const price = Number(body.priceMxn);
  if (!Number.isFinite(price) || price < 1 || price > 5000) throw err(400, 'El precio por foto debe ser entre $1 y $5,000 MXN.');
  const updated = await store.updateEvent(ev.id, { priceMxn: Math.round(price * 100) / 100 });
  // El precio que se ve en cada foto sale de la fila de participante del
  // fotógrafo (photoPrice), no del evento: si solo se actualiza el
  // evento, las fotos del dueño seguirían mostrando el precio viejo
  // (BUG 2026-11-17: álbum a $25, fotos a $20). Sincronizar la fila del
  // que guarda el precio; las de los demás fotógrafos no se tocan.
  // Si la tabla aún no existe, se ignora: sin fila, las fotos heredan el
  // precio del evento (mismo patrón que createEvent).
  try { await store.joinEvent(ev.id, user.id, updated.priceMxn); } catch (_) {}
  return { status: 200, data: { event: updated } };
}

// ---- Multi-fotógrafo: aprobación (solo el dueño) ----
async function approvePhotographer(store, user, body) {
  requireOwner(user);
  const target = await store.findUserById(Number(body.userId));
  if (!target) throw err(404, 'Cuenta no encontrada.');
  if (target.role !== 'photographer') throw err(400, 'Esa cuenta no es de fotógrafo.');
  if (target.isOwner && body.approve === false) throw err(400, 'El dueño no se puede desaprobar.');
  const updated = await store.updateUser(target.id, { approved: body.approve !== false });
  return { status: 200, data: { photographer: { id: updated.id, name: updated.name, email: updated.email, approved: updated.approved !== false, isOwner: !!updated.isOwner, payoutClabe: updated.payoutClabe || '' } } };
}

async function listPhotographers(store, user) {
  requireOwner(user);
  // Tres listas independientes: a la vez, no una tras otra.
  const [photographers, events, downloads] = await Promise.all([store.listPhotographers(), store.listEvents(), store.listAllDownloads()]);
  // Dueño de cada descarga: el fotógrafo DE LA FOTO (en eventos
  // compartidos, las ventas de los demás no son del creador del evento).
  // Panel rápido 2026-11-19 (D22): los dueños salen en lote (2
  // consultas); si el store no tiene los métodos nuevos, foto por foto.
  let ownerByPhoto = null;
  const _photoIds = [...new Set(downloads.map(d => d.photoId))].filter(id => Number.isInteger(id));
  const _photoRows = await tryStore(store, 'listPhotosByIds', _photoIds);
  if (_photoRows) {
    const _eventIds = [...new Set(_photoRows.map(p => p.eventId))].filter(id => Number.isInteger(id));
    const _eventRows = await tryStore(store, 'listEventsByIds', _eventIds);
    if (_eventRows) {
      const _eventById = new Map(_eventRows.map(e => [e.id, e]));
      ownerByPhoto = new Map(_photoRows.map(p => [p.id, photoOwnerId(p, _eventById.get(p.eventId))]));
    }
  }
  const photoOwnerCache = new Map();
  async function ownerOfDownload(d) {
    if (ownerByPhoto) return ownerByPhoto.get(d.photoId) ?? null;
    if (!photoOwnerCache.has(d.photoId)) {
      const p = await store.getPhoto(d.photoId);
      const ev = p ? await store.getEvent(p.eventId) : null;
      photoOwnerCache.set(d.photoId, p ? photoOwnerId(p, ev) : null);
    }
    return photoOwnerCache.get(d.photoId);
  }
  // Fotógrafos que llegaron por solicitud aprobada (tienen su solicitud
  // ligada). Los demás se registraron directo: "Sin solicitud". Si la
  // tabla de solicitudes aún no existe (falta correr el SQL), no se
  // rompe el panel: todos salen sin solicitud.
  let linked = new Set();
  try { linked = new Set((await store.listApplications()).map(a => a.photographerId).filter(id => id != null)); } catch (_) { linked = new Set(); }
  // Los dueños de las descargas se resuelven todos a la vez (antes cada
  // descarga esperaba a la anterior dentro del conteo por fotógrafo).
  await Promise.all([...new Set(downloads.map(d => d.photoId))].map(id => ownerOfDownload({ photoId: id })));
  const rows = [];
  for (const ph of photographers) {
    let eventCount = 0, totalSold = 0;
    for (const e of events) if (e.photographerId === ph.id) eventCount++;
    for (const d of downloads) if ((await ownerOfDownload(d)) === ph.id) totalSold += Number(d.amount || 0);
    rows.push({ id: ph.id, name: ph.name, email: ph.email, approved: ph.approved !== false, isOwner: !!ph.isOwner, payoutClabe: ph.payoutClabe || '', displayName: displayNameFor(ph), eventCount, totalSold: Math.round(totalSold * 100) / 100, hasApplication: linked.has(ph.id) });
  }
  return { status: 200, data: { photographers: rows } };
}

// ---- Solicitudes de fotógrafos: invitaciones ----
// El link de invitación vale 7 días. El token es un HMAC-SHA256 con
// AUTH_SECRET (mismo secreto que los tokens de sesión y de restablecer
// contraseña) sobre 'invite:<id de solicitud>:<azar>'; el azar hace que
// cada token sea único y no adivinable. La validez real vive en la base
// (status 'approved', sin vencer, sin usar), no en el token mismo.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function makeInviteToken(applicationId) {
  const secret = process.env.AUTH_SECRET || 'dev-secret-change-me';
  const rand = crypto.randomBytes(16).toString('hex');
  return crypto.createHmac('sha256', secret).update(`invite:${applicationId}:${rand}`).digest('hex');
}
function inviteIsValid(app, nowMs) {
  if (!app) return false;
  if (app.status !== 'approved') return false;
  if (!app.inviteToken) return false;
  if (app.photographerId != null) return false;
  if (!app.inviteExpiresAt) return false;
  return new Date(app.inviteExpiresAt).getTime() > (nowMs || Date.now());
}
function inviteUrlFor(token) {
  const base = (process.env.PUBLIC_URL || 'https://onlyclick-zeta.vercel.app').replace(/\/$/, '');
  return `${base}/?invite=${token}`;
}
function looksLikeUrl(s) {
  try { const u = new URL(String(s || '')); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (_) { return false; }
}

// ---- Notificaciones: avisos del dueño a los fotógrafos y noticias
// para los atletas (audience: 'athletes' | 'photographers' | 'all') ----
// Solo el dueño publica; cada grupo lee solo lo suyo. Un anuncio viejo
// sin audience se trata como solo fotógrafos, como antes. El autor
// nunca se muestra con nombre personal en la vista: solo título,
// mensaje y fecha.
const ANNOUNCEMENT_AUDIENCES = ['athletes', 'photographers', 'all'];
async function createAnnouncement(store, user, body) {
  requireOwner(user);
  const title = String(body.title || '').trim();
  const bodyText = String(body.body || '').trim();
  const audience = String(body.audience || 'athletes').trim().toLowerCase();
  if (!ANNOUNCEMENT_AUDIENCES.includes(audience)) throw err(400, 'Elige a quién va dirigida la noticia: atletas, fotógrafos o todos.');
  if (!title) throw err(400, 'La noticia necesita un título.');
  if (title.length > 80) throw err(400, 'El título no puede tener más de 80 caracteres.');
  if (!bodyText) throw err(400, 'La noticia necesita un mensaje.');
  if (bodyText.length > 500) throw err(400, 'El mensaje no puede tener más de 500 caracteres.');
  const a = await store.createAnnouncement({ title, body: bodyText, audience, createdBy: user.id });
  return { status: 201, data: { announcement: { id: a.id, title: a.title, body: a.body, audience: a.audience || 'photographers', createdAt: a.createdAt } } };
}

async function listAnnouncements(store, user) {
  requireUser(user);
  await expireOldEvents(store);
  // Cada grupo ve solo lo suyo: los fotógrafos ven avisos para
  // fotógrafos y para todos; los atletas ven noticias para atletas y
  // para todos. Un anuncio viejo sin audience es solo para fotógrafos.
  const isPhotog = user.role === 'photographer' && user.approved !== false;
  const isAthlete = user.role === 'athlete';
  const visible = (a) => {
    // Aviso para UNA cuenta (pago confirmado): solo esa cuenta lo ve,
    // sin importar el grupo.
    if (a.userId != null) return Number(a.userId) === Number(user.id);
    const aud = a.audience || 'photographers';
    if (aud === 'all') return isPhotog || isAthlete;
    if (aud === 'athletes') return isAthlete;
    return isPhotog;
  };
  const all = (await store.listAnnouncements()).filter(visible);
  // No leídos = avisos creados después de la última vez que el usuario
  // abrió las notificaciones. Si nunca las abrió, todos son no leídos.
  const seenAt = user.lastAnnouncementsSeenAt ? new Date(user.lastAnnouncementsSeenAt).getTime() : 0;
  const unread = all.filter(a => new Date(a.createdAt).getTime() > seenAt).length;
  // Avisos de caducidad para TODOS (atletas incluidos): álbumes del
  // usuario que desaparecen en 15 días o menos. Un aviso es nuevo si
  // entró en la ventana de 15 días después de la última visita.
  const expiring = await expiringEventsFor(store, user);
  const unreadExpiring = expiring.filter(w => w.warnFrom > seenAt).length;
  return { status: 200, data: { announcements: all.map(a => ({ id: a.id, title: a.title, body: a.body, audience: a.audience || 'photographers', createdAt: a.createdAt })), expiring: expiring.map(({ warnFrom, ...w }) => w), unreadCount: unread + unreadExpiring } };
}

async function markAnnouncementsRead(store, user) {
  requireUser(user);
  await store.updateUser(user.id, { lastAnnouncementsSeenAt: new Date().toISOString() });
  return { status: 200, data: { ok: true } };
}

// POST /api/submit-application — cualquiera manda su solicitud desde
// el inicio. Queda 'pending' hasta que Orlan la revise.
async function submitApplication(store, body) {
  const name = String(body.name || '').trim();
  const city = String(body.city || '').trim();
  const phone = String(body.phone || '').trim();
  const events = String(body.events || '').trim();
  const sampleLink = String(body.sampleLink || '').trim();
  const missing = [];
  if (!name) missing.push('Nombre completo');
  if (!city) missing.push('Ciudad y estado');
  if (!phone) missing.push('WhatsApp / teléfono');
  if (!events) missing.push('Eventos cubiertos');
  if (!sampleLink) missing.push('Link a tu trabajo');
  if (missing.length) throw err(400, 'Faltan campos obligatorios: ' + missing.join(', ') + '.');
  if (!looksLikeUrl(sampleLink)) throw err(400, 'El link a tu trabajo debe ser una dirección web válida (que empiece con http:// o https://).');
  const app = await store.createApplication({
    name, city, phone, events,
    camera: String(body.camera || '').trim(),
    sampleLink,
    specialty: String(body.specialty || '').trim(),
    dorsalExp: String(body.dorsalExp || '').trim(),
    availability: String(body.availability || '').trim(),
    clabe: String(body.clabe || '').trim(),
    message: String(body.message || '').trim(),
  });
  // Aviso al dueño por correo: hay una solicitud nueva por revisar en su
  // panel (Fotógrafos > Solicitudes). Si el correo falla o tarda, la
  // solicitud igual queda guardada: el aviso nunca la rompe.
  try {
    const owner = (await store.listPhotographers()).find(u => u.isOwner) || null;
    const ownerEmail = owner ? owner.email : (process.env.GMAIL_USER || '').trim();
    if (ownerEmail) {
      const camera = String(body.camera || '').trim();
      const specialty = String(body.specialty || '').trim();
      const availability = String(body.availability || '').trim();
      const clabe = String(body.clabe || '').trim();
      const message = String(body.message || '').trim();
      const detail = [
        `Nombre: ${name}`,
        `Ciudad: ${city}`,
        `WhatsApp: ${phone}`,
        `Eventos: ${events}`,
        camera ? `Cámara: ${camera}` : '',
        `Trabajo: ${sampleLink}`,
        specialty ? `Especialidad: ${specialty}` : '',
        availability ? `Disponibilidad: ${availability}` : '',
        clabe ? `CLABE: ${clabe}` : '',
        message ? `Mensaje: ${message}` : '',
      ].filter(Boolean).join('\n');
      await Promise.race([
        sendEmail({
          to: ownerEmail,
          subject: `Nueva solicitud de fotógrafo: ${name} (${city})`,
          text: `Hola,\n\n${name} quiere unirse como fotógrafo a OnlyClick:\n\n${detail}\n\nRevísala en tu panel: https://onlyclick-zeta.vercel.app/ (Cuenta → Panel fotógrafo → Fotógrafos → Solicitudes).`,
        }),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    }
  } catch (_) { /* el aviso nunca rompe la solicitud */ }
  return { status: 201, data: { ok: true, id: app.id } };
}

// GET /api/list-applications — solo el dueño, las más nuevas primero.
async function listApplications(store, user) {
  requireOwner(user);
  return { status: 200, data: { applications: await store.listApplications() } };
}

// POST /api/review-application { id, decision: 'approved'|'rejected' }
// — solo el dueño. Una solicitud revisada ya no se puede volver a
// revisar. Al aprobar se genera el link de invitación (7 días).
async function reviewApplication(store, user, body) {
  requireOwner(user);
  const app = await store.getApplicationById(Number(body.id));
  if (!app) throw err(404, 'Solicitud no encontrada.');
  const decision = String(body.decision || '');
  if (decision !== 'approved' && decision !== 'rejected') throw err(400, 'Decisión no válida.');
  if (app.status !== 'pending') throw err(400, 'Esta solicitud ya fue revisada.');
  if (decision === 'rejected') {
    await store.updateApplication(app.id, { status: 'rejected' });
    return { status: 200, data: { ok: true } };
  }
  const token = makeInviteToken(app.id);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  await store.updateApplication(app.id, { status: 'approved', inviteToken: token, inviteExpiresAt: expiresAt });
  return { status: 200, data: { ok: true, inviteUrl: inviteUrlFor(token), phone: app.phone } };
}

// GET /api/invite-status?token=... — público. Dice si el link sirve
// para crear la cuenta (aprobado, sin vencer, sin usar). No revela
// nada de solicitudes que no valen.
async function inviteStatus(store, query) {
  const token = String((query && query.token) || '');
  if (!token) return { status: 200, data: { valid: false } };
  const app = await store.getApplicationByToken(token);
  if (!inviteIsValid(app)) return { status: 200, data: { valid: false } };
  return { status: 200, data: { valid: true, name: app.name } };
}

// CLABE a donde Orlan le manda su parte al fotógrafo. La pone el propio
// fotógrafo en su panel (18 dígitos, como la de propinas).
async function setPayoutClabe(store, user, body) {
  requireUser(user);
  if (user.role !== 'photographer') throw err(403, 'Solo los fotógrafos reciben pagos por ventas.');
  const clabe = String(body.clabe || '').replace(/[\s-]/g, '');
  if (clabe && !/^\d{18}$/.test(clabe)) throw err(400, 'La CLABE debe tener 18 dígitos.');
  const updated = await store.setPayoutClabe(user.id, clabe);
  return { status: 200, data: { payoutClabe: updated ? (updated.payoutClabe || '') : clabe } };
}

// ---- Pagos y comisiones (solo el dueño, salvo my-earnings) ----
// Reparto de las ventas de un fotógrafo, en centavos enteros para que
// las sumas sean exactas. pending = descargas de pago sin payout_id
// (aún no liquidadas); pendingSince = la venta sin pagar más vieja.
// preloaded (opcional, lo pasa payoutsSummary): { downloads,
// ownerByPhoto } para compartir UNA lectura de descargas entre todos
// los fotógrafos en vez de una por fotógrafo.
// Panel rápido 2026-11-19 (D22): ANTES cada llamada leía TODAS las
// descargas y resolvía el dueño foto por foto (2 consultas por foto
// distinta). AHORA las fotos y sus eventos salen en lote (2 consultas
// en total); si el store no tiene los métodos nuevos, una por una.
async function photographerEarnings(store, photographerId, preloaded) {
  // Dos listas independientes: a la vez, no una tras otra.
  const [downloads, payouts] = (preloaded && preloaded.downloads)
    ? [preloaded.downloads, await store.listPayoutsByPhotographer(photographerId)]
    : await Promise.all([store.listAllDownloads(), store.listPayoutsByPhotographer(photographerId)]);
  // Solo las descargas de SUS fotos (en eventos compartidos, las fotos
  // de los demás fotógrafos no cuentan para él).
  let ownerByPhoto = (preloaded && preloaded.ownerByPhoto) || null;
  if (!ownerByPhoto) {
    const photoIds = [...new Set(downloads.map(d => d.photoId))].filter(id => Number.isInteger(id));
    const photoRows = await tryStore(store, 'listPhotosByIds', photoIds);
    if (photoRows) {
      const eventIds = [...new Set(photoRows.map(p => p.eventId))].filter(id => Number.isInteger(id));
      const eventRows = await tryStore(store, 'listEventsByIds', eventIds);
      if (eventRows) {
        const eventById = new Map(eventRows.map(e => [e.id, e]));
        ownerByPhoto = new Map(photoRows.map(p => [p.id, photoOwnerId(p, eventById.get(p.eventId))]));
      }
    }
  }
  if (!ownerByPhoto) {
    // Ruta vieja: una foto y un evento por foto distinta.
    const photoOwnerCache = new Map();
    async function ownerOf(d) {
      if (!photoOwnerCache.has(d.photoId)) {
        const p = await store.getPhoto(d.photoId);
        const ev = p ? await store.getEvent(p.eventId) : null;
        photoOwnerCache.set(d.photoId, p ? photoOwnerId(p, ev) : null);
      }
      return photoOwnerCache.get(d.photoId);
    }
    // Los dueños de las descargas se resuelven todos a la vez (antes cada
    // descarga esperaba a la anterior dentro del conteo).
    await Promise.all([...new Set(downloads.map(d => d.photoId))].map(id => ownerOf({ photoId: id })));
    ownerByPhoto = photoOwnerCache;
  }
  let totalSoldC = 0, clipC = 0, orlanC = 0, shareC = 0;
  let pendingShareC = 0, pendingClipC = 0, pendingOrlanC = 0, pendingSince = null;
  const pendingIds = [];
  for (const d of downloads) {
    if (ownerByPhoto.get(d.photoId) !== photographerId) continue;
    const amt = Number(d.amount || 0);
    if (!amt) continue; // gratis: no genera comisión ni pago
    // Con cupón de recompensa el fotógrafo cobra sobre el precio SIN
    // descuento (splitDownload); la parte de Orlan absorbe el 10%.
    const s = splitDownload(d);
    totalSoldC += Math.round(s.amount * 100);
    clipC += Math.round(s.clipFee * 100);
    orlanC += Math.round(s.orlanFee * 100);
    shareC += Math.round(s.photographerShare * 100);
    if (d.payoutId == null) {
      pendingShareC += Math.round(s.photographerShare * 100);
      pendingClipC += Math.round(s.clipFee * 100);
      pendingOrlanC += Math.round(s.orlanFee * 100);
      pendingIds.push(d.id);
      if (!pendingSince || String(d.createdAt) < pendingSince) pendingSince = String(d.createdAt);
    }
  }
  const paidShareC = payouts.filter(p => p.status === 'paid').reduce((sum, p) => sum + Math.round(Number(p.amountMxn || 0) * 100), 0);
  const lastPayout = payouts.filter(p => p.status === 'paid').sort((a, b) => b.id - a.id)[0] || null;
  const c2m = c => Math.round(c) / 100;
  return {
    totalSold: c2m(totalSoldC), clipFee: c2m(clipC), orlanFee: c2m(orlanC), photographerShare: c2m(shareC),
    pendingBalance: c2m(pendingShareC), pendingClipFee: c2m(pendingClipC), pendingOrlanFee: c2m(pendingOrlanC),
    pendingSince, pendingIds,
    paidShare: c2m(paidShareC),
    lastPayout: lastPayout ? { id: lastPayout.id, amountMxn: lastPayout.amountMxn, paidAt: lastPayout.paidAt, createdAt: lastPayout.createdAt } : null,
  };
}

async function payoutsSummary(store, user) {
  requireOwner(user);
  const photographers = (await store.listPhotographers()).filter(ph => !ph.isOwner);
  // Panel rápido 2026-11-19 (D22): ANTES las ganancias de cada
  // fotógrafo volvían a leer TODAS las descargas y a resolver foto por
  // foto (con 3 fotógrafos eran 3 escaneos completos + 2 consultas por
  // foto distinta, por fotógrafo). AHORA las descargas se leen UNA vez
  // y se comparten, y los dueños de las fotos se resuelven en lote.
  const downloads = await store.listAllDownloads();
  let ownerByPhoto = null;
  const photoIds = [...new Set(downloads.map(d => d.photoId))].filter(id => Number.isInteger(id));
  const photoRows = await tryStore(store, 'listPhotosByIds', photoIds);
  if (photoRows) {
    const eventIds = [...new Set(photoRows.map(p => p.eventId))].filter(id => Number.isInteger(id));
    const eventRows = await tryStore(store, 'listEventsByIds', eventIds);
    if (eventRows) {
      const eventById = new Map(eventRows.map(e => [e.id, e]));
      ownerByPhoto = new Map(photoRows.map(p => [p.id, photoOwnerId(p, eventById.get(p.eventId))]));
    }
  }
  const rows = [];
  const totals = { totalSold: 0, clipFee: 0, orlanFee: 0, photographerShare: 0, pendingBalance: 0 };
  // Las ganancias de cada fotógrafo son independientes: se calculan todas
  // a la vez (antes iban una por una y la pestaña Fotógrafos esperaba).
  const earningsList = await Promise.all(photographers.map(ph => photographerEarnings(store, ph.id, { downloads, ownerByPhoto })));
  for (let i = 0; i < photographers.length; i++) {
    const ph = photographers[i];
    const e = earningsList[i];
    let dueAt = null, isDue = false, hoursUntilDue = null;
    if (e.pendingSince) {
      // Vence 72 h después de la venta sin pagar más vieja.
      dueAt = new Date(new Date(e.pendingSince).getTime() + PAYOUT_DUE_HOURS * 3600 * 1000).toISOString();
      isDue = Date.now() >= new Date(dueAt).getTime();
      hoursUntilDue = Math.ceil((new Date(dueAt).getTime() - Date.now()) / 3600000);
    }
    rows.push({ photographerId: ph.id, name: ph.name, email: ph.email, approved: ph.approved !== false, payoutClabe: ph.payoutClabe || '', totalSold: e.totalSold, clipFee: e.clipFee, orlanFee: e.orlanFee, photographerShare: e.photographerShare, pendingBalance: e.pendingBalance, pendingSince: e.pendingSince, dueAt, isDue, hoursUntilDue, lastPayout: e.lastPayout });
    totals.totalSold += e.totalSold; totals.clipFee += e.clipFee; totals.orlanFee += e.orlanFee; totals.photographerShare += e.photographerShare; totals.pendingBalance += e.pendingBalance;
  }
  for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;
  return { status: 200, data: { photographers: rows, totals } };
}

// Aviso por correo cuando Orlan marca un pago como pagado: el fotógrafo
// recibe el desglose de lo que se le depositó. Se manda DESPUÉS de crear
// la fila de payout y liquidar las descargas, y SOLO al fotógrafo que se
// pagó (nunca a Orlan: él es el que paga). La CLABE nunca sale completa:
// solo sus últimos 4 dígitos. Las cifras salen de la fila de payout
// (amountMxn / clipFeeMxn / orlanFeeMxn) y el total de los pendientes de
// earnings; por la matemática en centavos de splitSale, W + Y + Z == T.
async function notifyPayout(store, ph, payout, settledCount, pendingTotals) {
  if (!ph || !ph.email) return;
  const w = Number(payout.amountMxn || 0);
  const y = Number(payout.clipFeeMxn || 0);
  const z = Number(payout.orlanFeeMxn || 0);
  // Total vendido de este pago: de earnings (pendientes liquidados); si no
  // viene, es la suma de la fila de payout (misma cifra por construcción).
  const t = pendingTotals
    ? Math.round((Number(pendingTotals.pendingBalance || 0) + Number(pendingTotals.pendingClipFee || 0) + Number(pendingTotals.pendingOrlanFee || 0)) * 100) / 100
    : Math.round((w + y + z) * 100) / 100;
  const digits = String(ph.payoutClabe || '').replace(/\D/g, '');
  const clabeTxt = digits.length >= 4 ? `a tu CLABE terminada en ****${digits.slice(-4)}` : 'a tu CLABE';
  const date = String(payout.paidAt || '').slice(0, 10);
  const n = Number(settledCount || 0);
  // El texto plano también abre con el encabezado (decisión de Orlan).
  const text = `Recibiste pago de OnlyClick\n\nHola ${displayNameFor(ph)},\n\nOnlyClick te depositó $${w.toFixed(2)} MXN ${clabeTxt}.\n\nDesglose de este pago:\n• Fotos vendidas pagadas: ${n}\n• Total vendido: $${t.toFixed(2)} MXN\n• Comisión Clip (4.18%): $${y.toFixed(2)} MXN\n• Comisión OnlyClick (10%): $${z.toFixed(2)} MXN\n• Te depositamos: $${w.toFixed(2)} MXN\n\nFecha del pago: ${date}\n\nPuedes verlo en tu panel de fotógrafo.`;
  // HTML propio (no el <br> automático): encabezado GRANDE con el título,
  // el monto depositado destacado y el desglose como lista.
  const html = `<h1 style="font-size:28px;line-height:1.2;color:#b8860b;margin:0 0 8px;">Recibiste pago de OnlyClick</h1>`
    + `<p style="font-size:22px;font-weight:bold;color:#111111;margin:0 0 12px;">Te depositamos $${w.toFixed(2)} MXN</p>`
    + `<p style="font-size:15px;color:#222222;">Hola ${displayNameFor(ph)},</p>`
    + `<p style="font-size:15px;color:#222222;">OnlyClick te depositó $${w.toFixed(2)} MXN ${clabeTxt}.</p>`
    + `<p style="font-size:15px;color:#222222;margin-bottom:4px;">Desglose de este pago:</p>`
    + `<ul style="font-size:15px;color:#222222;">`
    + `<li>Fotos vendidas pagadas: ${n}</li>`
    + `<li>Total vendido: $${t.toFixed(2)} MXN</li>`
    + `<li>Comisión Clip (4.18%): $${y.toFixed(2)} MXN</li>`
    + `<li>Comisión OnlyClick (10%): $${z.toFixed(2)} MXN</li>`
    + `<li><strong>Te depositamos: $${w.toFixed(2)} MXN</strong></li>`
    + `</ul>`
    + `<p style="font-size:15px;color:#222222;">Fecha del pago: ${date}</p>`
    + `<p style="font-size:15px;color:#222222;">Puedes verlo en tu panel de fotógrafo.</p>`;
  await sendEmail({
    to: ph.email,
    subject: `¡Te pagamos en OnlyClick! $${w.toFixed(2)} MXN`,
    text,
    html,
  });
}

// Orlan ya envió el dinero: se crea la fila de payout (status 'paid') y
// sus descargas quedan ligadas (salen del saldo pendiente). Se puede
// pagar antes de las 72 h; la pestaña solo resalta los vencidos en rojo.
async function markPayoutPaid(store, user, body) {
  requireOwner(user);
  const ph = await store.findUserById(Number(body.photographerId));
  if (!ph) throw err(404, 'Fotógrafo no encontrado.');
  if (ph.role !== 'photographer') throw err(400, 'Esa cuenta no es de fotógrafo.');
  if (ph.isOwner) throw err(400, 'El dueño no necesita que le paguen: ese dinero ya es suyo.');
  const e = await photographerEarnings(store, ph.id);
  if (!e.pendingIds.length || e.pendingBalance <= 0) throw err(400, 'Este fotógrafo no tiene saldo pendiente.');
  const now = new Date().toISOString();
  const payout = await store.createPayout({ photographerId: ph.id, amountMxn: e.pendingBalance, orlanFeeMxn: e.pendingOrlanFee, clipFeeMxn: e.pendingClipFee, status: 'paid', paidAt: now });
  const settled = await store.updateDownloadsPayout(e.pendingIds, payout.id);
  // Aviso al fotógrafo con el desglose. El pago YA quedó registrado: si el
  // correo falla o tarda, se espera máximo 4 s y se sigue (nunca rompe
  // el "Marcar como pagado").
  try { await Promise.race([notifyPayout(store, ph, payout, settled, e), new Promise(r => setTimeout(r, 4000))]); } catch (err2) { console.error('aviso de pago falló:', err2 && err2.message); }
  return { status: 200, data: { payout: { id: payout.id, photographerId: ph.id, name: ph.name, amountMxn: payout.amountMxn, orlanFeeMxn: payout.orlanFeeMxn, clipFeeMxn: payout.clipFeeMxn, status: payout.status, paidAt: payout.paidAt }, downloadsSettled: settled } };
}

async function payoutsHistory(store, user) {
  requireOwner(user);
  // Dos listas independientes: a la vez, no una tras otra.
  const [payouts, photographers] = await Promise.all([store.listPayouts(), store.listPhotographers()]);
  const names = new Map(photographers.map(ph => [ph.id, ph.name || '']));
  return { status: 200, data: { payouts: payouts.map(p => ({ id: p.id, photographerId: p.photographerId, photographerName: names.get(p.photographerId) || '', amountMxn: p.amountMxn, orlanFeeMxn: p.orlanFeeMxn, clipFeeMxn: p.clipFeeMxn, status: p.status, createdAt: p.createdAt, paidAt: p.paidAt })) } };
}

// Lo que lleva ganado el fotógrafo que llama: vendido, su parte
// pendiente y lo que ya le pagaron. Sirve también estando pendiente
// de aprobación (todo en ceros hasta que venda).
async function myEarnings(store, user) {
  requireUser(user);
  if (user.role !== 'photographer') throw err(403, 'Solo los fotógrafos tienen ganancias por ventas.');
  const e = await photographerEarnings(store, user.id);
  return { status: 200, data: { totalSold: e.totalSold, clipFee: e.clipFee, orlanFee: e.orlanFee, photographerShare: e.photographerShare, pendingBalance: e.pendingBalance, pendingSince: e.pendingSince, paidShare: e.paidShare, lastPayout: e.lastPayout } };
}

// ---- Eventos compartidos ----
function validPrice(v) {
  const p = Number(v);
  if (!Number.isFinite(p) || p < 1 || p > 5000) return null;
  return Math.round(p * 100) / 100;
}

// POST /api/join-event { eventId, priceMxn } — un fotógrafo aprobado
// entra LIBRE a un evento creado por otro (o por el dueño) y vende sus
// fotos ahí a su precio. Volver a unirse solo actualiza el precio.
async function joinEvent(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(Number(body.eventId));
  if (!ev) throw err(404, 'Evento no encontrado.');
  const price = validPrice(body.priceMxn);
  if (price == null) throw err(400, 'El precio por foto debe ser entre $1 y $5,000 MXN.');
  if (ev.photographerId === user.id) return { status: 200, data: { ok: true, alreadyCreator: true, eventId: ev.id, priceMxn: ev.priceMxn } };
  // Álbum exclusivo OnlyClick: ningún otro fotógrafo se puede unir ni
  // vender fotos ahí; solo el dueño sube fotos.
  if (ev.isExclusive) throw err(403, 'Este álbum es exclusivo OnlyClick: solo el dueño sube fotos.');
  const row = await store.joinEvent(ev.id, user.id, price);
  return { status: 200, data: { ok: true, eventId: ev.id, photographerId: user.id, priceMxn: row.priceMxn } };
}

// POST /api/leave-event { eventId } — salir de un evento compartido.
// No se puede salir si ya subiste fotos ahí (esas fotos ya son parte
// del evento y pueden estar vendidas). El creador no "sale" de su
// propio evento: si ya no lo quiere, lo borra.
async function leaveEvent(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(Number(body.eventId));
  if (!ev) throw err(404, 'Evento no encontrado.');
  if (ev.photographerId === user.id) throw err(400, 'Eres el creador de este evento: para quitarlo usa "Eliminar evento".');
  const mine = (await store.listPhotos(ev.id)).filter(p => photoOwnerId(p, ev) === user.id);
  if (mine.length) throw err(400, 'Ya subiste ' + mine.length + ' foto(s) a este evento: no puedes salir. Tus fotos se quedan en el evento.');
  await store.leaveEvent(ev.id, user.id);
  return { status: 200, data: { ok: true } };
}

// GET /api/event-participants?eventId=... — público: quiénes participan
// en el evento, con su nombre a mostrar, cuántas fotos y su precio.
async function eventParticipants(store, user, query) {
  const ev = await store.getEvent(Number(query.eventId));
  if (!ev) throw err(404, 'Evento no encontrado.');
  // Participantes de un álbum oculto: solo los ve el dueño.
  assertEventVisible(user, ev);
  const parts = await store.listParticipants(ev.id).catch(() => []);
  const users = new Map((await store.listPhotographers()).map(u => [u.id, u]));
  const photos = await store.listPhotos(ev.id);
  const list = (parts.length ? parts : [{ photographerId: ev.photographerId, priceMxn: ev.priceMxn }])
    .map(pt => {
      const u = users.get(Number(pt.photographerId));
      return { photographerId: Number(pt.photographerId), displayName: displayNameFor(u), photoCount: photos.filter(p => photoOwnerId(p, ev) === Number(pt.photographerId)).length, priceMxn: Number(pt.priceMxn) };
    });
  return { status: 200, data: { eventId: ev.id, participants: list, isShared: parts.length > 1 } };
}

// POST /api/set-display-name { displayName } — el nombre que sale en
// "Foto de ...": primer nombre, apodo o marca/página (máx. 40 caracteres).
// Vacío = volver al primer nombre.
async function setDisplayName(store, user, body) {
  requirePhotographer(user);
  const name = String(body.displayName || '').trim().slice(0, 40);
  const updated = await store.setDisplayName(user.id, name);
  return { status: 200, data: { displayName: updated ? (updated.displayName || '') : name } };
}

// POST /api/set-my-event-price { eventId, priceMxn } — cambiar MI precio
// en un evento compartido. Si eres el creador, cambia el precio del
// evento (el que heredan las fotos sin participante).
async function setMyEventPrice(store, user, body) {
  requirePhotographer(user);
  const ev = await store.getEvent(Number(body.eventId));
  if (!ev) throw err(404, 'Evento no encontrado.');
  // Álbum exclusivo: no tiene precio, las fotos son gratis.
  if (ev.isExclusive) throw err(400, 'Un álbum exclusivo OnlyClick no tiene precio: las fotos son gratis.');
  const price = validPrice(body.priceMxn);
  if (price == null) throw err(400, 'El precio por foto debe ser entre $1 y $5,000 MXN.');
  if (ev.photographerId === user.id) {
    const updated = await store.updateEvent(ev.id, { priceMxn: price });
    // Igual que set-event-price: el precio de cada foto sale de la fila
    // de participante del fotógrafo (photoPrice), así que también se
    // sincroniza la fila del creador; si no, sus fotos seguirían con el
    // precio viejo aunque el evento ya diga el nuevo (BUG 2026-11-17).
    try { await store.joinEvent(ev.id, user.id, updated.priceMxn); } catch (_) {}
    return { status: 200, data: { event: updated } };
  }
  const part = await store.getParticipant(ev.id, user.id).catch(() => null);
  if (!part) throw err(403, 'No participas en ese evento. Únete primero.');
  const row = await store.joinEvent(ev.id, user.id, price);
  return { status: 200, data: { ok: true, priceMxn: row.priceMxn } };
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
    // Recompensas (2026-11-20): referidos + primeros 100 atletas.
    case 'rewards': { requireUser(user); return { status: 200, data: await getRewards(store, user) }; }
    case 'rewards-check': { requireUser(user); return rewardsCheck(store, user); }
    case 'referral-info': return { status: 200, data: await referralInfo(store, req.query.code) };
    case 'list-events': return listEvents(store, user);
    case 'create-event': return createEvent(store, user, b);
    case 'get-event': return getEvent(store, user, req.query.eventId, req.query);
    case 'upload-photo': return uploadPhoto(store, user, b);
    case 'backfill-thumbs': return backfillThumbs(store, user, b);
    case 'subscribe-photo-alert': return subscribePhotoAlert(store, user, b);
    case 'photo-meta': return photoMeta(store, req.query);
    case 'shared-cart': return sharedCart(store, req.query);
    case 'search': return searchBib(store, user, req.query);
    case 'claim': return claimPhotos(store, user, b, false);
    // Compra simulada DESACTIVADA: con Clip real, /api/purchase dejaba
    // descargar sin pagar. El cobro es POST /api/checkout-create.
    case 'purchase': throw err(410, 'El pago ahora es con Clip. Usa el botón "Pagar y descargar".');
    case 'my-photos': return listPurchases(store, user);
    case 'remove-download': return removeDownload(store, user, b);
    case 'sales': return listSales(store, user);
    case 'track-view': return trackView(store, user, b);
    case 'stats': return listStats(store, user);
    case 'set-free-mode': return setFreeMode(store, user, b);
    case 'set-event-hidden': return setEventHidden(store, user, b);
    case 'set-event-upcoming': return setEventUpcoming(store, user, b);
    case 'set-tip': return setTip(store, user, b);
    case 'update-photo': return updatePhoto(store, user, b);
    case 'delete-photo': return deletePhoto(store, user, req.query.photoId || b.photoId);
    case 'delete-event': return deleteEvent(store, user, b);
    case 'upload-cover': return uploadCover(store, user, b);
    case 'cover-file': return coverFile(store, user, req.query.eventId);
    case 'read-bib': return readBib(store, user, b);
    case 'face-search': return faceSearch(store, user, b);
    case 'face-search-instant': return faceSearchInstant(store, user, b);
    case 'index-photo-faces': return indexPhotoFaces(store, user, b);
    case 'checkout-create': return createCheckout(store, user, b);
    case 'checkout-create-cart': return createCartCheckout(store, user, b);
    case 'checkout-return': return checkoutReturn(store, req.query);
    case 'checkout-status': return checkoutStatus(store, user, b);
    case 'clip-webhook': return clipWebhook(store, b, req.query);
    case 'validate-discount-code': return validateDiscountCode(store, user, b);
    case 'create-discount-code': return createDiscountCode(store, user, b);
    case 'generate-discount-codes': return generateDiscountCodes(store, user, b);
    case 'list-discount-codes': return listDiscountCodes(store, user, b);
    case 'deactivate-discount-code': return deactivateDiscountCode(store, user, b);
    case 'set-event-price': return setEventPrice(store, user, b);
    case 'approve-photographer': return approvePhotographer(store, user, b);
    case 'list-photographers': return listPhotographers(store, user);
    case 'create-announcement': return createAnnouncement(store, user, b);
    case 'list-announcements': return listAnnouncements(store, user);
    case 'mark-announcements-read': return markAnnouncementsRead(store, user);
    case 'submit-application': return submitApplication(store, b);
    case 'list-applications': return listApplications(store, user);
    case 'review-application': return reviewApplication(store, user, b);
    case 'invite-status': return inviteStatus(store, req.query);
    case 'set-payout-clabe': return setPayoutClabe(store, user, b);
    case 'payouts-summary': return payoutsSummary(store, user);
    case 'payouts-mark-paid': return markPayoutPaid(store, user, b);
    case 'payouts-history': return payoutsHistory(store, user);
    case 'my-earnings': return myEarnings(store, user);
    case 'join-event': return joinEvent(store, user, b);
    case 'leave-event': return leaveEvent(store, user, b);
    case 'event-participants': return eventParticipants(store, user, req.query);
    case 'set-display-name': return setDisplayName(store, user, b);
    case 'set-my-event-price': return setMyEventPrice(store, user, b);
    case 'photo-file': return photoFile(store, user, req.query.id, req);
    default: throw err(404, 'Ruta no encontrada: ' + route);
  }
}

module.exports = { dispatch, err, cartTotals, singleDiscountForPosition, splitAmount, splitSale, splitRewardSale, splitDownload, makeReferralCode, referralLink, referralShareLink, early100ShareText, referralInviteShareText, photographerShareText, ogMetaForRef, DEFAULT_OG, resolveReferrer, generateRewardCoupon, maybeGrantReferralCoupon, maybeGrantEarlyCoupon, ensureEarly100Notice, rewardsCheck, getRewards, referralInfo, maybeGrantPhotographerRewards, maybeApplyFreeSale, PHOTOG_REWARD_MILESTONE, PHOTOG_REWARD_PER_BLOCK, PHOTOG_REWARD_REFERRAL_STARS, EARLY100_NOTIF_TITLE, EARLY100_NOTIF_BODY, PACKAGE_SIZE, PACKAGE_DISCOUNT, SINGLE_TIERS, CART_MAX_TOTAL, CART_MAX_ITEMS, CLIP_FEE_RATE, ORLAN_FEE_RATE, PAYOUT_DUE_HOURS, makeInviteToken, inviteIsValid, INVITE_TTL_MS, displayNameFor, photoOwnerId, discountCodePrefix, makeDiscountCode, DISCOUNT_CODE_CHARS, DISCOUNT_CODE_SUFFIX_LEN, validMaxUses, validDiscountPercent };
