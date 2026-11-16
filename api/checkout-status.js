'use strict';
// POST /api/checkout-status { paymentRequestId } o { photoId }
// El frontend pregunta si un pago pendiente ya se confirmó (útil para
// pagos en efectivo en OXXO, que se confirman después).
// NOTA: en Vercel este archivo es código muerto; la ruta real vive en
// server.js ROUTES + handlers.js.
const { dispatch, err } = require('./_lib/handlers');
const { tokenFromReq } = require('./_lib/auth');

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
    const result = await dispatch('checkout-status', { body, query: req.query || {}, token: tokenFromReq({ ...req, body }) });
    res.status(result.status || 200).json(result.data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Error del servidor.' });
  }
};
