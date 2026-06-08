// netlify/functions/mp-webhook.js
// Recibe notificaciones de Mercado Pago. Si el pago quedó aprobado,
// dispara la cadena automática (procesarPago) para ese pedido.
//
// Variables de entorno: MP_ACCESS_TOKEN
// MP siempre espera 200 rápido; si devolvemos error, reintenta.

const { procesarPago } = require('./_procesar-pago');

exports.handler = async (event) => {
  const TOKEN = process.env.MP_ACCESS_TOKEN;
  const ok = (extra) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ received: true }, extra || {})) });

  if (!TOKEN) return ok({ error: 'Falta MP_ACCESS_TOKEN' });

  // Identificar el payment id (MP manda por GET query o POST body)
  let paymentId = null, topic = null;
  const qs = event.queryStringParameters || {};
  if (qs['data.id']) paymentId = qs['data.id'];
  if (qs['id'] && (qs['topic'] === 'payment' || qs['type'] === 'payment')) paymentId = qs['id'];
  topic = qs['type'] || qs['topic'] || null;

  if (!paymentId && event.body) {
    try {
      const b = JSON.parse(event.body);
      topic = topic || b.type || b.topic || null;
      if (b.data && b.data.id) paymentId = b.data.id;
      else if (b.resource && /\/payments\//.test(b.resource)) paymentId = b.resource.split('/').pop();
      else if (b.id && (b.type === 'payment' || b.topic === 'payment')) paymentId = b.id;
    } catch (_) {}
  }

  if (topic && topic !== 'payment') return ok({ ignored: topic });
  if (!paymentId) return ok({ note: 'sin payment id' });

  try {
    // Consultar el pago real a MP (nunca confiar solo en la notificación)
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    });
    const pago = await resp.json();
    if (!resp.ok) return ok({ error: 'No se pudo consultar el pago', detalle: pago });

    if (pago.status !== 'approved') return ok({ estado: pago.status, note: 'pago no aprobado aún' });

    // external_reference = id del pedido (lo seteamos al crear la preferencia)
    const pedidoId = parseInt(pago.external_reference || (pago.metadata && pago.metadata.pedido_id) || 0, 10);
    if (!pedidoId) return ok({ note: 'sin pedido asociado' });

    const r = await procesarPago({
      pedidoId,
      mpPaymentId: String(paymentId),
      metodo: 'Mercado Pago',
      monto: pago.transaction_amount || 0
    });

    return ok({ pedidoId, pasos: r.pasos });
  } catch (err) {
    return ok({ error: String(err) });
  }
};
