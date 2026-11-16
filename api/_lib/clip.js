'use strict';
// Cliente mínimo de Clip — Checkout Redireccionado (v2).
//
// Docs oficiales (developer.clip.mx):
//   - Crear link:   https://developer.clip.mx/reference?page=cnp-mxn
//   - Consultar:    https://developer.clip.mx/reference?page=cnp-st
//   - Webhooks:     https://developer.clip.mx/reference?page=cnp-lwh
//   - Autenticación: https://developer.clip.mx/reference?page=i-auth
//   - Ayuda (comisión 3.6% + IVA): https://ayuda.clip.mx/s/article/checkout-clip
//
// Base: https://api.payclip.com — mismo host para producción y pruebas;
// la credencial test_ selecciona el entorno de pruebas. IMPORTANTE: las
// llaves test_ NO sirven para links de Checkout Redireccionado (solo
// Checkout Transparente y Reembolsos); la prueba de punta a punta debe
// hacerse en producción con un cobro real pequeño.
// Auth: HTTP Basic — Authorization: Basic base64(CLIP_API_KEY:CLIP_API_SECRET)
// (clave y secreto van en UNA sola cabecera, unidos por ':').

const CLIP_BASE = 'https://api.payclip.com';

function clipAuthHeader() {
  const key = process.env.CLIP_API_KEY || '';
  const secret = process.env.CLIP_API_SECRET || '';
  if (!key || !secret) {
    const e = new Error('Faltan las credenciales de Clip (CLIP_API_KEY / CLIP_API_SECRET en Vercel).');
    e.status = 500;
    throw e;
  }
  return 'Basic ' + Buffer.from(key + ':' + secret, 'utf8').toString('base64');
}

async function clipRequest(method, path, body) {
  const res = await fetch(CLIP_BASE + path, {
    method,
    headers: {
      'Authorization': clipAuthHeader(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const detail = (data && (data.message || data.error || data.detail)) || text || ('HTTP ' + res.status);
    const e = new Error('Clip (' + res.status + '): ' + detail);
    e.status = 502;
    e.clipStatus = res.status;
    // 412 = rate limit en Clip: reintentar con backoff exponencial.
    e.retryable = res.status === 412 || res.status >= 500;
    throw e;
  }
  return data;
}

// POST /v2/checkout — crea un link de pago (payment_request).
// Campos requeridos: amount (float, mín 1, 2 decimales), currency "MXN",
// purchase_description (1-255 caracteres). Opcionales usados aquí:
// redirection_url {success, error, default}, metadata {external_reference
// máx 36 chars, customer_info {name, email, phone}}, webhook_url,
// override_settings {locale, tip_enabled}, expires_at (default 72h).
// Respuesta: payment_request_id, payment_request_url (https://pago.clip.mx/{id}),
// status CHECKOUT_CREATED, expires_at, etc.
async function createCheckoutLink(opts) {
  const amount = Number(opts.amount);
  if (!Number.isFinite(amount) || amount < 1) throw new Error('El monto mínimo de Clip es $1 MXN.');
  const body = {
    amount: Math.round(amount * 100) / 100,
    currency: opts.currency || 'MXN',
    purchase_description: String(opts.purchase_description || 'Foto OnlyClick').slice(0, 255),
  };
  if (opts.redirection_url) body.redirection_url = opts.redirection_url;
  if (opts.metadata) body.metadata = opts.metadata;
  if (opts.webhook_url) body.webhook_url = opts.webhook_url;
  if (opts.override_settings) body.override_settings = opts.override_settings;
  if (opts.custom_payment_options) body.custom_payment_options = opts.custom_payment_options;
  if (opts.expires_at) body.expires_at = opts.expires_at;
  return clipRequest('POST', '/v2/checkout', body);
}

// GET /v2/checkout/{payment_request_id} — estado real del pago.
// status: CHECKOUT_CREATED | CHECKOUT_PENDING | CHECKOUT_CANCELLED |
// CHECKOUT_EXPIRED | CHECKOUT_COMPLETED. receipt_no solo cuando está
// completado. Es la ÚNICA fuente confiable de si se pagó o no.
async function getCheckout(paymentRequestId) {
  if (!paymentRequestId) throw new Error('Falta payment_request_id.');
  return clipRequest('GET', '/v2/checkout/' + encodeURIComponent(paymentRequestId));
}

module.exports = { createCheckoutLink, getCheckout, CLIP_BASE };
