// netlify/functions/mp-crear-pago.js
// Crea una preferencia de pago (Checkout Pro) en Mercado Pago.
// El frontend (portal.html o gastro.html) llama a esta funcion con los
// datos del pedido, y devuelve el init_point (URL de pago) para mandarle al cliente.
//
// Variables de entorno necesarias en Netlify:
//   MP_ACCESS_TOKEN  -> Access Token de produccion (APP_USR-...)
//   SITE_URL         -> (opcional) URL base del sitio, ej: https://lovely-oveja-partemil.netlify.app
//                       Si no se setea, se arma desde los headers.
//   GAS_COBROS_URL   -> (opcional) URL /exec del GAS de Cobros, para que el webhook avise

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ success: false, error: 'Metodo no permitido' }) };
  }

  const TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ success: false, error: 'Falta MP_ACCESS_TOKEN en Netlify' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'JSON invalido' }) };
  }

  // Datos esperados desde el frontend:
  //   pedidoId    -> id del pedido en el sistema (external_reference + metadata)
  //   descripcion -> texto del item
  //   monto       -> importe total a cobrar
  //   clienteNombre, clienteEmail (opcional)
  const pedidoId      = String(data.pedidoId || '').trim();
  const descripcion   = String(data.descripcion || 'Pedido Monnoserie').trim();
  const monto         = Number(data.monto);
  const clienteNombre = String(data.clienteNombre || '').trim();
  const clienteEmail  = String(data.clienteEmail || '').trim();

  if (!monto || monto <= 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'Monto invalido' }) };
  }

  const proto = (event.headers['x-forwarded-proto'] || 'https');
  const host  = (event.headers['host'] || '');
  const SITE  = (process.env.SITE_URL || `${proto}://${host}`).replace(/\/$/, '');

  const preference = {
    items: [
      {
        id: pedidoId || 'pedido',
        title: descripcion.slice(0, 250),
        quantity: 1,
        currency_id: 'ARS',
        unit_price: Math.round(monto * 100) / 100
      }
    ],
    external_reference: pedidoId,
    metadata: { pedido_id: pedidoId },
    back_urls: {
      success: `${SITE}/portal.html?pago=ok`,
      pending: `${SITE}/portal.html?pago=pendiente`,
      failure: `${SITE}/portal.html?pago=error`
    },
    auto_return: 'approved',
    notification_url: `${SITE}/.netlify/functions/mp-webhook`,
    statement_descriptor: 'MONNOSERIE'
  };

  if (clienteNombre || clienteEmail) {
    preference.payer = {};
    if (clienteNombre) preference.payer.name = clienteNombre;
    if (clienteEmail)  preference.payer.email = clienteEmail;
  }

  try {
    const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`
      },
      body: JSON.stringify(preference)
    });

    const result = await resp.json();

    if (!resp.ok) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ success: false, error: result.message || 'Error de Mercado Pago', detalle: result })
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        preferenceId: result.id,
        initPoint: result.init_point,
        sandboxInitPoint: result.sandbox_init_point
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ success: false, error: String(err) })
    };
  }
};
