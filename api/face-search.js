'use strict';
// Busca fotos por selfie con reconocimiento facial (Gemini). Ver handlers.faceSearch.
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
    const result = await dispatch('face-search', { body, query: req.query || {}, token: tokenFromReq({ ...req, body }) });
    res.status(result.status || 200).json(result.data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Error del servidor.' });
  }
};
