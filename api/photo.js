'use strict';
const { dispatch } = require('./_lib/handlers');
const { tokenFromReq } = require('./_lib/auth');

module.exports = async (req, res) => {
  try {
    const result = await dispatch('photo-file', { body: {}, query: req.query || {}, token: tokenFromReq(req) });
    res.setHeader('Content-Type', result.file.mimeType);
    res.setHeader('Content-Disposition', result.file.inline ? 'inline' : `attachment; filename="${result.file.filename}"`);
    res.setHeader('Content-Length', result.file.bytes.length);
    // Los bytes de una foto nunca cambian para un id.
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.status(200).send(result.file.bytes);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Error del servidor.' });
  }
};
