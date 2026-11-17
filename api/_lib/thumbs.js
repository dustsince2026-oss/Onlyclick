'use strict';
// Miniaturas de galería generadas EN EL SERVIDOR (para el backfill de
// fotos viejas). La galería ya pide /api/photo?thumb=1 y el servidor ya
// sirve la miniatura cuando existe; lo que faltaba era GENERARLA para las
// fotos subidas antes del 2026-11-15 (las 649 del Trijex no tienen
// thumb_path y cada vista de la cuadrícula baja la foto completa, ~300 KB,
// y eso se comió la cuota de egress de Supabase: 5.93/5 GB).
//
// Sin dependencias nativas: jpeg-js puro JS (decode -> bilinear ->
// encode). No se usa sharp a propósito: es un binario nativo grande y un
// fallo en su instalación tumbaría el deploy de Vercel; jpeg-js es JS
// plano y no puede fallar por plataforma. Solo JPEG (todas las fotos que
// sube el cliente son JPEG: el cliente comprime a 1600px y manda
// mimeType 'image/jpeg'); cualquier otro formato devuelve null y el
// backfill lo salta sin romper nada (la galería sigue cayendo a la foto
// completa, como hoy).
//
// La miniatura es SOLO para la cuadrícula y los resultados de búsqueda:
// 400px de ancho, calidad 70 (~30-50 KB). El original NUNCA se toca:
// la vista ampliada (lightbox), la descarga y la compra siguen usando la
// foto completa.
const THUMB_MAX_W = 400;
const THUMB_QUALITY = 70;

function jpegLib() {
  try { return require('jpeg-js'); } catch (_) { return null; }
}

function thumbsAvailable() {
  return !!jpegLib();
}

// buffer: bytes de la foto original (JPEG). mimeType: 'image/jpeg'.
// Devuelve { buffer, width, height } o null si no se pudo generar.
function makeThumb(buffer, mimeType) {
  if (!buffer || !buffer.length) return null;
  const mt = String(mimeType || '').toLowerCase();
  if (mt && mt !== 'image/jpeg' && mt !== 'image/jpg') return null;
  const jpeg = jpegLib();
  if (!jpeg) return null;
  let raw;
  try { raw = jpeg.decode(buffer, { maxMemoryUsageInMB: 512 }); } catch (_) { return null; }
  if (!raw || !raw.width || !raw.height || !raw.data || raw.data.length < raw.width * raw.height * 4) return null;
  const scale = Math.min(1, THUMB_MAX_W / raw.width);
  const w = Math.max(1, Math.round(raw.width * scale));
  const h = Math.max(1, Math.round(raw.height * scale));
  const out = Buffer.alloc(w * h * 4);
  // Remuestreo bilineal RGBA.
  for (let y = 0; y < h; y++) {
    const sy = Math.min(raw.height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(raw.height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(raw.width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(raw.width - 1, x0 + 1), fx = sx - x0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = raw.data[(y0 * raw.width + x0) * 4 + c];
        const b = raw.data[(y0 * raw.width + x1) * 4 + c];
        const cc = raw.data[(y1 * raw.width + x0) * 4 + c];
        const d = raw.data[(y1 * raw.width + x1) * 4 + c];
        out[o + c] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy);
      }
    }
  }
  let enc;
  try { enc = jpeg.encode({ data: out, width: w, height: h }, THUMB_QUALITY); } catch (_) { return null; }
  if (!enc || !enc.data || !enc.data.length) return null;
  return { buffer: Buffer.from(enc.data), width: w, height: h };
}

module.exports = { makeThumb, thumbsAvailable, THUMB_MAX_W, THUMB_QUALITY };
