// netlify/functions/cambiar-estado.js
// POST /api/cambiar-estado  { pedidoId, estado, token }
// El operador avanza el pedido: en_preparacion -> listo -> entregado.
// (El paso a 'en_preparacion' lo hace solo la cadena de pago; esto es para el resto.)

const { supabase, ok, bad, preflight } = require('./_supabase');
const { enviarNotificacion } = require('./_email');

const ESTADOS = ['pendiente', 'en_preparacion', 'listo', 'entregado', 'cancelado'];

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (body && body.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }

  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const pedidoId = parseInt(body.pedidoId, 10);
  const estado = String(body.estado || '').trim();
  if (!pedidoId) return bad(400, 'Falta pedidoId');
  if (!ESTADOS.includes(estado)) return bad(400, 'Estado inválido');

  try {
    const { error } = await supabase.from('pedidos').update({ estado }).eq('id', pedidoId);
    if (error) return bad(500, error.message);

    // Registrar el cambio en la bitácora
    await supabase.from('eventos_pedido').insert({ pedido_id: pedidoId, tipo: 'cambio_estado', detalle: estado });

    // Email "listo" (fire-and-forget): solo al pasar a 'listo'
    if (estado === 'listo') {
      const { data: p } = await supabase
        .from('pedidos')
        .select('id, total, clientes(nombre, email), detalle_pedidos(nombre, cantidad, subtotal)')
        .eq('id', pedidoId)
        .maybeSingle();
      const emailCli = p && p.clientes && p.clientes.email;
      if (emailCli) {
        await enviarNotificacion('listo', emailCli, {
          id: pedidoId,
          nombre: p.clientes.nombre,
          total: p.total,
          items: (p.detalle_pedidos || []).map(d => ({ nombre: d.nombre, cantidad: d.cantidad, subtotal: Number(d.subtotal) }))
        });
      }
    }

    return ok({ success: true, pedidoId, estado });
  } catch (err) {
    return bad(500, String(err));
  }
};
