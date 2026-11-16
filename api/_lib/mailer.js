'use strict';
// Envío de correos con Gmail (contraseña de aplicación) + nodemailer.
// Variables en Vercel: GMAIL_USER (tu correo) y GMAIL_APP_PASSWORD
// (contraseña de aplicación de 16 caracteres, se crea en la cuenta de Google).
// Sin ellas, el restablecimiento de contraseña no puede enviar el correo.
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function getTransporter() {
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) { throw new Error('El envío de correos no está instalado.'); }
  const user = (process.env.GMAIL_USER || '').trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
  if (!user || !pass) throw new Error('El envío de correos no está configurado.');
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

async function sendResetEmail(to, name, link) {
  const transporter = getTransporter();
  const from = (process.env.GMAIL_USER || '').trim();
  await transporter.sendMail({
    from: `"OnlyClick" <${from}>`,
    to,
    subject: 'Restablece tu contraseña de OnlyClick',
    text: `Hola ${name || ''},\n\nTe pidieron restablecer tu contraseña de OnlyClick. Abre este enlace (vale 1 hora):\n${link}\n\nSi no fuiste tú, ignora este correo.`,
    html: `<p>Hola ${esc(name || '')},</p><p>Te pidieron restablecer tu contraseña de OnlyClick. Abre este enlace (vale 1 hora):</p><p><a href="${esc(link)}">${esc(link)}</a></p><p>Si no fuiste tú, ignora este correo.</p>`,
  });
}

async function sendSaleEmail({ to, subject, text, html }) {
  const transporter = getTransporter();
  const from = (process.env.GMAIL_USER || '').trim();
  await transporter.sendMail({
    from: `"OnlyClick" <${from}>`,
    to,
    subject,
    text,
    html: html || text.replace(/\n/g, '<br>'),
  });
}

module.exports = { sendResetEmail, sendSaleEmail };
