// netlify/functions/mis-pedidos.js
// GET /api/mis-pedidos?telefono=...
// Devuelve los pedidos del cliente (validado por teléfono) con su detalle.

const { supabase, ok, bad, preflight } = require('./_supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');

  const telefono = String((event.queryStringParameters && event.queryStringParameters.telefono) || '').trim();
  if (!telefono) return bad(400, 'Falta el teléfono');

  try {
    // 1) Buscar cliente
    const { data: cliente, error: errCli } = await supabase
      .from('clientes')
      .select('id, nombre')
      .eq('telefono', telefono)
      .maybeSingle();

    if (errCli) return bad(500, errCli.message);
    if (!cliente) return ok({ success: true, cliente: null, pedidos: [] });

    // 2) Pedidos del cliente + detalle (join via embedding de Supabase)
    const { data: pedidos, error: errPed } = await supabase
      .from('pedidos')
      .select('id, canal, fecha_pedido, fecha_entrega, estado, total, medio_pago, estado_pago, notas, detalle_pedidos(nombre, cantidad, precio_unitario, subtotal)')
      .eq('cliente_id', cliente.id)
      .order('fecha_pedido', { ascending: false })
      .limit(50);

    if (errPed) return bad(500, errPed.message);

    const salida = (pedidos || []).map(p => ({
      id: p.id,
      canal: p.canal,
      fecha: p.fecha_pedido,
      fechaEntrega: p.fecha_entrega,
      estado: p.estado,
      estadoPago: p.estado_pago,
      medioPago: p.medio_pago,
      notas: p.notas,
      total: Number(p.total),
      items: (p.detalle_pedidos || []).map(d => ({
        nombre: d.nombre,
        cantidad: d.cantidad,
        subtotal: Number(d.subtotal)
      }))
    }));

    return ok({ success: true, cliente, pedidos: salida });
  } catch (err) {
    return bad(500, String(err));
  }
};
