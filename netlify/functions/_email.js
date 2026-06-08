// netlify/functions/_email.js
// Envío de emails transaccionales por SMTP (nodemailer). Costo cero:
// funciona con Gmail, Brevo, Resend o cualquier SMTP.
//
// Variables de entorno:
//   SMTP_HOST     ej: smtp.gmail.com  | smtp-relay.brevo.com | smtp.resend.com
//   SMTP_PORT     ej: 587 (STARTTLS) o 465 (SSL)
//   SMTP_USER     usuario SMTP
//   SMTP_PASS     contraseña / app password / api key
//   FROM_EMAIL    remitente visible, ej: "Monnoserie <pedidos@tudominio.com>"
//   SITE_URL      ej: https://tu-sitio.netlify.app  (para el logo del email)
//
// Si no hay SMTP configurado, las funciones de envío no hacen nada (no rompen).

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) {}

const COL = { violeta: '#5453A3', violetaOsc: '#3F3E7A', violetaVivo: '#6346BA', crema: '#F4F1EA', tinta: '#1A1A22' };

function hayConfig() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function transporte() {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 = SSL; 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function money(n) { return '$' + Number(n || 0).toLocaleString('es-AR'); }

// Plantilla HTML común (header violeta + logo + cuerpo)
function plantilla({ titulo, saludo, cuerpo, pedido, items }) {
  const site = (process.env.SITE_URL || '').replace(/\/$/, '');
  const logo = site ? `<img src="${site}/logo.png" alt="Monnoserie" width="56" style="display:block;margin:0 auto 8px;border:0">` : '';
  const listaItems = (items && items.length)
    ? `<table role="presentation" width="100%" style="margin:14px 0;border-collapse:collapse">
         ${items.map(i => `<tr>
           <td style="padding:6px 0;border-bottom:1px solid #eee;font-size:14px;color:#444"><b>${i.cantidad}×</b> ${i.nombre}</td>
           <td style="padding:6px 0;border-bottom:1px solid #eee;font-size:14px;color:#444;text-align:right">${money(i.subtotal)}</td>
         </tr>`).join('')}
       </table>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${COL.crema}">
  <table role="presentation" width="100%" style="background:${COL.crema};padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="520" style="max-width:520px;width:100%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 14px rgba(63,62,122,.12)">
        <tr><td style="background:linear-gradient(135deg,${COL.violeta},${COL.violetaOsc});padding:24px;text-align:center">
          ${logo}
          <div style="font-family:'Trebuchet MS',Verdana,sans-serif;font-size:24px;font-weight:bold;color:#fff;letter-spacing:.5px">Monnoserie</div>
          <div style="font-family:'Trebuchet MS',Verdana,sans-serif;font-size:11px;color:#e8e6f7;letter-spacing:2px;text-transform:uppercase;margin-top:2px">Viennoiserie de Mendoza</div>
        </td></tr>
        <tr><td style="padding:28px 28px 8px">
          <h1 style="font-family:'Trebuchet MS',Verdana,sans-serif;font-size:20px;color:${COL.violetaOsc};margin:0 0 6px">${titulo}</h1>
          <p style="font-family:Arial,sans-serif;font-size:15px;color:#333;line-height:1.55;margin:0">${saludo}</p>
          <p style="font-family:Arial,sans-serif;font-size:15px;color:#333;line-height:1.55;margin:10px 0 0">${cuerpo}</p>
          ${listaItems}
          ${pedido ? `<div style="font-family:'Trebuchet MS',Verdana,sans-serif;text-align:right;font-size:18px;color:${COL.violetaVivo};font-weight:bold;margin-top:4px">Total: ${money(pedido.total)}</div>` : ''}
        </td></tr>
        <tr><td style="padding:16px 28px 28px;text-align:center">
          <p style="font-family:Arial,sans-serif;font-size:12px;color:#999;margin:14px 0 0">Monnoserie · Mendoza 🐵 · @monnoserie</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

const PLANTILLAS = {
  recibido: (p) => ({
    subject: `Recibimos tu pedido #${p.id} 🐵`,
    html: plantilla({
      titulo: '¡Pedido recibido!',
      saludo: `Hola ${p.nombre || ''}!`,
      cuerpo: 'Recibimos tu pedido y ya lo estamos viendo. Te avisamos apenas esté listo. ¡Gracias por elegirnos!',
      pedido: p, items: p.items
    })
  }),
  pagado: (p) => ({
    subject: `Confirmamos el pago de tu pedido #${p.id} ✅`,
    html: plantilla({
      titulo: 'Pago confirmado ✅',
      saludo: `Hola ${p.nombre || ''}!`,
      cuerpo: 'Confirmamos el pago de tu pedido. Ya lo estamos preparando con todo el cariño 🥐 Te avisamos cuando esté listo para retirar.',
      pedido: p, items: p.items
    })
  }),
  listo: (p) => ({
    subject: `Tu pedido #${p.id} ya está listo 🎉`,
    html: plantilla({
      titulo: '¡Tu pedido está listo! 🎉',
      saludo: `Hola ${p.nombre || ''}!`,
      cuerpo: 'Tu pedido ya está listo para retirar. Te esperamos en Monnoserie. ¡Que lo disfrutes! 🐵',
      pedido: p, items: p.items
    })
  })
};

/**
 * Envía un email de notificación. Fire-and-forget: nunca lanza.
 * @param {string} tipo  'recibido' | 'pagado' | 'listo'
 * @param {string} para  email destino
 * @param {Object} datos { id, nombre, total, items }
 * @returns {Promise<{enviado:boolean, motivo?:string}>}
 */
async function enviarNotificacion(tipo, para, datos) {
  try {
    if (!hayConfig()) return { enviado: false, motivo: 'sin_config_smtp' };
    if (!para || !/.+@.+\..+/.test(para)) return { enviado: false, motivo: 'sin_email' };
    const fab = PLANTILLAS[tipo];
    if (!fab) return { enviado: false, motivo: 'tipo_desconocido' };

    const { subject, html } = fab(datos);
    await transporte().sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: para,
      subject,
      html
    });
    return { enviado: true };
  } catch (e) {
    return { enviado: false, motivo: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { enviarNotificacion, hayConfig };
