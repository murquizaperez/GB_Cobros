// netlify/functions/mp-webhook.js
// Recibe las notificaciones (IPN/Webhook) de Mercado Pago cuando cambia el
// estado de un pago. Si el pago quedo aprobado, consulta el detalle del pago,
// saca el external_reference (= id del pedido) y le avisa al GAS de Cobros
// para que marque el pedido como PAGADO y avance el estado.
//
// Variables de entorno necesarias en Netlify:
//   MP_ACCESS_TOKEN  -> Access Token de produccion (APP_USR-...)
//   GAS_COBROS_URL   -> URL /exec del GAS de Cobros (donde vive registrarPagoMP)
//
// MP siempre espera un 200 rapido; si devolvemos error reintenta.

exports.handler = async (event) => {
  // MP manda notificaciones por GET (query) y por POST (body). Soportamos ambas.
  const TOKEN = process.env.MP_ACCESS_TOKEN;
  const GAS   = process.env.GAS_COBROS_URL;

  // Respuesta estandar 200 (para que MP no reintente infinito)
  const ok = (extra) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ received: true }, extra || {}))
  });

  if (!TOKEN) return ok({ error: 'Falta MP_ACCESS_TOKEN' });

  // 1) Identificar el id de pago desde la notificacion
  let paymentId = null;
  let topic = null;

  // Por query string (?type=payment&data.id=123  o  ?topic=payment&id=123)
  const qs = event.queryStringParameters || {};
  if (qs['data.id']) paymentId = qs['data.id'];
  if (qs['id'] && (qs['topic'] === 'payment' || qs['type'] === 'payment')) paymentId = qs['id'];
  topic = qs['type'] || qs['topic'] || null;

  // Por body JSON
  if (!paymentId && event.body) {
    try {
      const b = JSON.parse(event.body);
      topic = topic || b.type || b.topic || null;
      if (b.data && b.data.id) paymentId = b.data.id;
      else if (b.resource && /\/payments\//.test(b.resource)) {
        paymentId = b.resource.split('/').pop();
      } else if (b.id && (b.type === 'payment' || b.topic === 'payment')) {
        paymentId = b.id;
      }
    } catch (e) { /* body no era JSON */ }
  }

  // Solo nos interesan notificaciones de pagos
  if (topic && topic !== 'payment') return ok({ ignored: topic });
  if (!paymentId) return ok({ note: 'sin payment id' });

  try {
    // 2) Consultar el detalle real del pago a MP (nunca confiar solo en la notificacion)
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    });
    const pago = await resp.json();

    if (!resp.ok) return ok({ error: 'No se pudo consultar el pago', detalle: pago });

    const estado     = pago.status;                       // approved | pending | rejected | ...
    const pedidoId   = pago.external_reference ||
                       (pago.metadata && pago.metadata.pedido_id) || '';
    const monto      = pago.transaction_amount || 0;
    const metodo     = pago.payment_method_id || 'mercadopago';
    const fecha      = (pago.date_approved || pago.date_created || '').split('T')[0];

    // 3) Si esta aprobado y tenemos GAS configurado, avisar al sistema de cobros
    if (estado === 'approved' && GAS && pedidoId) {
      try {
        await fetch(GAS, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            fn: 'registrarPagoMP',
            args: [{
              pedidoId: pedidoId,
              monto: monto,
              metodo: 'Mercado Pago',
              mpPaymentId: String(paymentId),
              fecha: fecha
            }]
          })
        });
      } catch (e) {
        // Si falla el aviso al GAS, igual devolvemos 200 a MP (reintenta luego)
        return ok({ estado, pedidoId, gasError: String(e) });
      }
    }

    return ok({ estado, pedidoId, paymentId: String(paymentId) });
  } catch (err) {
    return ok({ error: String(err) });
  }
};
