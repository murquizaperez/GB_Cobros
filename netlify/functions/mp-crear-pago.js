// netlify/functions/mp-crear-pago.js
// POST /api/mp-crear-pago  { pedidoId, descripcion, monto, clienteNombre, clienteEmail }
// Crea una preferencia de Checkout Pro. external_reference = pedidoId (Supabase),
// para que el webhook sepa qué pedido confirmar.
//
// Env: MP_ACCESS_TOKEN, SITE_URL (opcional)

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ success: false, error: 'Método no permitido' }) };

  const TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ success: false, error: 'Falta MP_ACCESS_TOKEN' }) };

  let data;
  try { data = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'JSON inválido' }) }; }

  const pedidoId = String(data.pedidoId || '').trim();
  const monto = Number(data.monto);
  if (!pedidoId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'Falta pedidoId' }) };
  if (!monto || monto <= 0) return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'Monto inválido' }) };

  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['host'] || '';
  const SITE = (process.env.SITE_URL || `${proto}://${host}`).replace(/\/$/, '');

  const preference = {
    items: [{ id: pedidoId, title: String(data.descripcion || 'Pedido Monnoserie').slice(0, 250), quantity: 1, currency_id: 'ARS', unit_price: Math.round(monto * 100) / 100 }],
    external_reference: pedidoId,
    metadata: { pedido_id: pedidoId },
    back_urls: {
      success: `${SITE}/minorista.html?pago=ok`,
      pending: `${SITE}/minorista.html?pago=pendiente`,
      failure: `${SITE}/minorista.html?pago=error`
    },
    auto_return: 'approved',
    notification_url: `${SITE}/.netlify/functions/mp-webhook`,
    statement_descriptor: 'MONNOSERIE'
  };
  if (data.clienteNombre || data.clienteEmail) {
    preference.payer = {};
    if (data.clienteNombre) preference.payer.name = String(data.clienteNombre);
    if (data.clienteEmail) preference.payer.email = String(data.clienteEmail);
  }

  try {
    const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify(preference)
    });
    const result = await resp.json();
    if (!resp.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ success: false, error: result.message || 'Error de Mercado Pago' }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, preferenceId: result.id, initPoint: result.init_point }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ success: false, error: String(err) }) };
  }
};
