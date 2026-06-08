// netlify/functions/confirmar-pago.js
// POST /api/confirmar-pago   { pedidoId, metodo }
// Lo usa el OPERADOR desde el panel para confirmar un pago en efectivo o
// transferencia con 1 clic. Dispara la misma cadena que el webhook de MP.

const { procesarPago } = require('./_procesar-pago');
const { ok, bad, preflight } = require('./_supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }

  const pedidoId = parseInt(body.pedidoId, 10);
  const metodo = ['Transferencia', 'Efectivo', 'Mercado Pago'].includes(body.metodo) ? body.metodo : 'Transferencia';
  if (!pedidoId) return bad(400, 'Falta pedidoId');

  try {
    const r = await procesarPago({ pedidoId, metodo });
    return ok(r);
  } catch (err) {
    return bad(500, String(err));
  }
};
