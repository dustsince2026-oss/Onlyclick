'use strict';
// GET /api/checkout-return?ref=...&photoId=...
// Clip redirige aquí tras el pago. Verifica el estado con Clip y
// redirige (302) al corredor a la app con ?paid=1 | pay=pending | pay=failed.
// NOTA: en Vercel este archivo es código muerto; la ruta real es el caso
// especial de server.js (antes del router /api/*) + handlers.js.
const { dispatch } = require('./_lib/handlers');
const { tokenFromReq } = require('./_lib/auth');

module.exports = async (req, res) => {
  try {
    const result = await dispatch('checkout-return', { body: {}, query: req.query || {}, token: tokenFromReq(req) });
    if (result.redirect) {
      res.writeHead(302, { Location: result.redirect });
      return res.end();
    }
    res.status(result.status || 200).json(result.data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Error del servidor.' });
  }
};
