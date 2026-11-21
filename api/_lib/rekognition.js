'use strict';
// Cliente mínimo de AWS Rekognition (Fase 2: búsqueda por selfie instantánea).
// Sin dependencias nuevas: las llamadas se firman a mano (Signature
// Version 4) y se mandan con fetch, igual que Gemini en handlers.js.
// NUNCA se ponen llaves en el código: se leen de las variables de
// entorno de Vercel (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// AWS_REGION). Orlan las pega él mismo en Vercel; nunca van en el repo
// ni en el chat.
// Precios verificados 2026-11-17: ~$1 USD por cada 1,000 imágenes
// procesadas (IndexFaces y SearchFacesByImage cuentan igual), $0.01 USD
// por cada 1,000 caras guardadas al mes, y los primeros 5,000 imágenes
// al mes gratis por 12 meses. Sin suscripción mensual: se paga por uso.
// Azure Face se descartó (mismo precio, pero Microsoft exige aprobación
// de "Limited Access" para identificar caras; Amazon no).
const crypto = require('crypto');

// Se usa por objeto de módulo (rekognition.searchFacesByImage) y no
// desestructurado, para que los tests puedan cambiar el simulado a mitad
// de la corrida (igual que clip en handlers.js).
function getConfig() {
  const clean = (v) => String(v || '').replace(/[^\x20-\x7E]/g, '').trim();
  const accessKeyId = clean(process.env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = clean(process.env.AWS_SECRET_ACCESS_KEY);
  const region = clean(process.env.AWS_REGION) || 'us-east-1';
  return { accessKeyId, secretAccessKey, region, configured: !!(accessKeyId && secretAccessKey) };
}
function isConfigured() { return getConfig().configured; }

// Una colección por evento: al borrar el álbum se borra su colección y
// no queda ninguna cara guardada. Solo [a-zA-Z0-9_.-], máx. 255.
function collectionIdFor(eventId) { return 'onlyclick-event-' + Number(eventId); }

function sha256Hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
// Codificación RFC 3986 que exige el canonical query de SigV4
// (encodeURIComponent deja ! ' ( ) * sin codificar; AWS no).
function encodeRfc3986(v) { return encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }

// Firma una petición HTTP (Signature Version 4) y devuelve los datos
// para armar el header Authorization. Función pura: se prueba con dos
// vectores verificados contra el SDK oficial de AWS
// (@aws-sdk/signature-v4, 2026-11-17): GET IAM ListUsers (firma
// b2e4af44cfad96d9ffa3c5653674a927b9b0995c33de22e1f843745ce37c1d5e) y POST
// Rekognition SearchFacesByImage (firma 720320820c50f1e083cd25e348bbdf927f00770dd89577771de48dcbe69befe6).
// opts: { method, url, headers, body, accessKeyId, secretAccessKey,
//   region, service, amzDate } — body es string o Buffer ('' si no hay).
function signRequest(opts) {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = new URL(opts.url);
  const payload = opts.body == null ? '' : (Buffer.isBuffer(opts.body) ? opts.body : String(opts.body));
  const payloadHash = sha256Hex(payload);
  const amzDate = opts.amzDate || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const headers = {};
  for (const [k, v] of Object.entries(opts.headers || {})) headers[String(k).toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers.host = u.host;
  headers['x-amz-date'] = amzDate;
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map(n => n + ':' + headers[n] + '\n').join('');
  const signedHeaders = sortedNames.join(';');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map(([k, v]) => k + '=' + v).join('&');
  const canonicalRequest = [method, u.pathname || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + opts.region + '/' + opts.service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + opts.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    authorization: 'AWS4-HMAC-SHA256 Credential=' + opts.accessKeyId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    signature, signedHeaders, amzDate, canonicalRequest, stringToSign,
  };
}

class RekognitionError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code || 'RekognitionError';
    this.status = status || 500;
  }
}

// Una llamada al API JSON de Rekognition (POST / con X-Amz-Target).
// opts.fetchImpl permite inyectar un fetch simulado en los tests.
async function call(action, body, opts) {
  const cfg = getConfig();
  if (!cfg.configured) throw new RekognitionError('no-key', 'Faltan las llaves de AWS (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).', 500);
  const fetchImpl = (opts && opts.fetchImpl) || module.exports.fetchImpl || fetch;
  const url = 'https://rekognition.' + cfg.region + '.amazonaws.com/';
  const payload = JSON.stringify(body || {});
  const baseHeaders = { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'RekognitionService.' + action };
  const signed = signRequest({ method: 'POST', url, headers: baseHeaders, body: payload, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, service: 'rekognition' });
  const res = await fetchImpl(url, { method: 'POST', headers: { ...baseHeaders, Authorization: signed.authorization, 'X-Amz-Date': signed.amzDate }, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawType = String((json && json.__type) || '');
    const code = rawType.split('#').pop() || ('HTTP' + res.status);
    throw new RekognitionError(code, String((json && json.message) || ('Rekognition devolvió error ' + res.status)).slice(0, 200), res.status);
  }
  return json;
}

// Crea la colección del evento. Si ya existe, no es error (devuelve ok
// igual): al indexar en paralelo, dos llamadas pueden chocar.
async function createCollection(collectionId, opts) {
  try {
    await call('CreateCollection', { CollectionId: collectionId }, opts);
    return { ok: true, created: true };
  } catch (e) {
    if (e.code === 'ResourceAlreadyExistsException') return { ok: true, created: false };
    throw e;
  }
}

// Indexa UNA foto: devuelve sus caras [{ Face: { FaceId, Confidence,
// BoundingBox } }]. MaxFaces 100 (máximo de AWS por foto).
async function indexFaces(collectionId, imageBytes, externalImageId, opts) {
  const res = await call('IndexFaces', {
    CollectionId: collectionId,
    Image: { Bytes: Buffer.from(imageBytes).toString('base64') },
    ExternalImageId: String(externalImageId),
    MaxFaces: 100,
    DetectionAttributes: ['DEFAULT'],
  }, opts);
  return res.FaceRecords || [];
}

// Busca la selfie en la colección del evento. Devuelve FaceMatches:
// [{ Face: { FaceId, ... }, Similarity }], ordenados por parecido.
// FaceMatchThreshold: mínimo % para que AWS la cuente como coincidencia.
async function searchFacesByImage(collectionId, imageBytes, opts) {
  const threshold = (opts && Number(opts.threshold)) || 90;
  const maxFaces = (opts && Number(opts.maxFaces)) || 100;
  const res = await call('SearchFacesByImage', {
    CollectionId: collectionId,
    Image: { Bytes: Buffer.from(imageBytes).toString('base64') },
    FaceMatchThreshold: threshold,
    MaxFaces: maxFaces,
  }, opts);
  return { FaceMatches: res.FaceMatches || [], SearchedFaceConfidence: res.SearchedFaceConfidence };
}

// Borra caras sueltas (al borrar una foto). FaceIds que ya no existen se
// ignoran: Rekognition devuelve los que no pudo borrar en UnsuccessfulFaceDeletions.
async function deleteFaces(collectionId, faceIds, opts) {
  const cfg = getConfig();
  if (!cfg.configured) return { ok: false, reason: 'no-key' };
  const ids = (faceIds || []).filter(Boolean);
  if (!ids.length) return { ok: true, deleted: [] };
  const res = await call('DeleteFaces', { CollectionId: collectionId, FaceIds: ids }, opts);
  return { ok: true, deleted: res.DeletedFaces || [] };
}

// Borra la colección entera (al borrar/caducar el álbum). Mejor esfuerzo:
// si no hay llaves o la colección ya no existe, no rompe nada.
async function deleteCollection(collectionId, opts) {
  const cfg = getConfig();
  if (!cfg.configured) return { ok: false, reason: 'no-key' };
  try {
    await call('DeleteCollection', { CollectionId: collectionId }, opts);
    return { ok: true };
  } catch (e) {
    if (e.code === 'ResourceNotFoundException') return { ok: true, existed: false };
    throw e;
  }
}

module.exports = {
  getConfig, isConfigured, collectionIdFor, signRequest, RekognitionError,
  call, createCollection, indexFaces, searchFacesByImage, deleteFaces, deleteCollection,
  fetchImpl: null,
};
