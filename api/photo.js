'use strict';
const { dispatch } = require('./_lib/handlers');
const { tokenFromReq } = require('./_lib/auth');

module.exports = async (req, res) => {
  try {
    const result = await dispatch('photo-file', { body: {}, query: req.query || {}, token: tokenFromReq(req) });
    res.setHeader('Content-Type', result.file.mimeType);
    res.setHeader('Content-Disposition', result.file.inline ? 'inline' : `attachment; filename="${result.file.filename}"`);
    res.setHeader('Content-Length', result.file.bytes.length);
    // Caché del edge (Vercel): `s-maxage` es lo que lee la CDN; `max-age`
    // solo lo lee el navegador. Sin s-maxage cada vista volvía a ejecutar
    // la función y a bajar la foto de Supabase (eso se comió los 7.52 GB
    // de Fast Origin Transfer). Solo se cachea cuando los bytes no
    // dependen del usuario (lo decide photoFile): la miniatura siempre,
    // la completa solo en eventos gratis. La descarga y la vista previa
    // de pago llevan `no-store` para que nadie reciba bytes de otro.
    res.setHeader('Cache-Control', result.file.cacheable ? 'public, max-age=86400, s-maxage=86400, immutable' : 'private, max-age=0, no-store');
    res.status(200).send(result.file.bytes);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Error del servidor.' });
  }
};
