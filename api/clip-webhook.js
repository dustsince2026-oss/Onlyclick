'use strict';
// POST /api/clip-webhook?s=<CLIP_WEBHOOK_SECRET>
// Aviso de Clip cuando cambia un pago. Payload v2 mínimo:
//   { id, resource: "CHECKOUT"|"REFUND", resource_status }
// Clip NO firma sus notificaciones: el secreto en la URL solo descarta
// avisos falsos baratos. El webhook NUNCA desbloquea por sí solo: siempre
// se vuelve a consultar GET /v2/checkout/{id} en Clip.
// Responde 200 rápido (Clip reintenta si no recibe 2xx en <5 s).
// NOTA: en Vercel este archivo es código muerto; la ruta real vive en
// server.js ROUTES + handlers.js.
const { dispatch } = require('./_lib/handlers');

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await dispatch('clip-webhook', { body, query: req.query || {}, token: null });
    res.status(result.status || 200).json(result.data);
  } catch (e) {
    // Nunca devolver error a Clip por un fallo nuestro: si devolvemos 5xx
    // Clip reintentará; el pago se verifica igual por checkout-return y
    // por /api/checkout-status. Se responde 200 con el motivo.
    res.status(200).json({ ok: false, reason: e.message || 'error' });
  }
};
