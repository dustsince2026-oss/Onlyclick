'use strict';
const { dispatch } = require('./_lib/handlers');
const { tokenFromReq } = require('./_lib/auth');

module.exports = async (req, res) => {
  try {
    const result = await dispatch('cover-file', { body: {}, query: req.query || {}, token: tokenFromReq(req) });
    res.setHeader('Content-Type', result.file.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Length', result.file.bytes.length);
    // Caché del edge (Vercel): la portada es igual para todos los que ven
    // el evento (el álbum oculto exige token en la URL: su clave de caché
    // es solo del dueño). Sin `immutable`: la portada sí se puede cambiar
    // y el cambio debe verse sin esperar un día (el navegador revalida
    // cada hora, el edge la guarda un día).
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.status(200).send(result.file.bytes);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Error del servidor.' });
  }
};
