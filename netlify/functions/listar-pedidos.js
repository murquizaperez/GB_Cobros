// netlify/functions/listar-pedidos.js
// GET /api/listar-pedidos?estado=...&token=...
// Panel admin: devuelve todos los pedidos (más recientes primero) con datos
// del cliente y el detalle. Protegido por ADMIN_TOKEN.
//
// Env: ADMIN_TOKEN (si no está seteado, el panel queda abierto — conviene setearlo)

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true; // sin token configurado => abierto (para testing)
  const got = (event.headers['x-admin-token'] ||
    (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event)) return bad(401, 'No autorizado');

  const qs = event.queryStringParameters || {};
  const estado = (qs.estado || '').trim();
  const limit = Math.min(parseInt(qs.limit || '100', 10) || 100, 300);

  try {
    let q = supabase
      .from('pedidos')
      .select('id, canal, fecha_pedido, fecha_entrega, estado, total, medio_pago, estado_pago, quiere_factura, notas, direccion, cliente_id, clientes(nombre, telefono, email), detalle_pedidos(nombre, cantidad, subtotal), facturas(afip_numero, cae, qr_url, error)')
      .order('fecha_pedido', { ascending: false })
      .limit(limit);

    if (estado) q = q.eq('estado', estado);

    const { data, error } = await q;
    if (error) return bad(500, error.message);

    const pedidos = (data || []).map(p => {
      const fac = Array.isArray(p.facturas) ? p.facturas[0] : p.facturas;
      return {
        id: p.id,
        canal: p.canal,
        fecha: p.fecha_pedido,
        fechaEntrega: p.fecha_entrega,
        estado: p.estado,
        estadoPago: p.estado_pago,
        medioPago: p.medio_pago,
        quiereFactura: p.quiere_factura,
        notas: p.notas,
        direccion: p.direccion,
        total: Number(p.total),
        cliente: p.clientes ? { nombre: p.clientes.nombre, telefono: p.clientes.telefono, email: p.clientes.email } : null,
        items: (p.detalle_pedidos || []).map(d => ({ nombre: d.nombre, cantidad: d.cantidad, subtotal: Number(d.subtotal) })),
        factura: fac ? { numero: fac.afip_numero, cae: fac.cae, qr: fac.qr_url, error: fac.error } : null
      };
    });

    return ok({ success: true, pedidos });
  } catch (err) {
    return bad(500, String(err));
  }
};
