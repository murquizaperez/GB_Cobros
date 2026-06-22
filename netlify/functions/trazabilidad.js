// netlify/functions/trazabilidad.js
// Da soporte a los botones "Etiqueta" y "Trazabilidad" del módulo Producción.
//
// GET ?loteId=N&token=...        → por id de lote
// GET ?lote=L260620-PROD-CEA6&token=...  → por código de trazabilidad
//
// Devuelve:
//   etiqueta: { codigo, producto, responsable, fecha, cantidad, costoReal, costoTeorico, estado }
//   trazabilidad: { sinVentas, totalUnidades, ventas:[{ pedidoId, canal, fecha, estado, medioPago, cantidad, subtotal }] }
//
// ⚠️ Recordá el redirect en netlify.toml:  /api/trazabilidad -> /.netlify/functions/trazabilidad
// (o el catch-all /api/* que ya tenés).

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const qs = event.queryStringParameters || {};
  const got = (event.headers['x-admin-token'] || qs.token || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event)) return bad(401, 'No autorizado');

  const qs = event.queryStringParameters || {};
  const loteId = qs.loteId ? parseInt(qs.loteId, 10) : null;
  const codigoIn = qs.lote ? String(qs.lote).trim() : null;
  if (!loteId && !codigoIn) return bad(400, 'Falta loteId o lote (código)');

  try {
    // --- Lote (para Etiqueta) ---
    let q = supabase
      .from('lotes_produccion')
      .select('id, codigo_trazabilidad, cantidad_producida, cantidad_esperada, costo_total, costo_teorico, estado, empleado, responsable, fecha, hora_inicio, hora_fin, productos(nombre)');
    q = loteId ? q.eq('id', loteId) : q.eq('codigo_trazabilidad', codigoIn);
    const { data: lote } = await q.maybeSingle();
    if (!lote) return bad(404, 'Lote no encontrado');

    const codigo = lote.codigo_trazabilidad;
    const etiqueta = {
      codigo,
      producto: lote.productos ? lote.productos.nombre : '',
      responsable: lote.empleado || lote.responsable || 'Sin registrar',
      fecha: lote.hora_fin || lote.hora_inicio || lote.fecha,
      cantidad: Number(lote.cantidad_producida) || 0,
      cantidadEsperada: lote.cantidad_esperada == null ? null : Number(lote.cantidad_esperada),
      costoReal: Number(lote.costo_total) || 0,
      costoTeorico: lote.costo_teorico == null ? null : Number(lote.costo_teorico),
      estado: lote.estado || 'finalizado'
    };

    // --- Ventas vinculadas (para Trazabilidad) ---
    const { data: lineas } = await supabase
      .from('detalle_pedidos')
      .select('cantidad, precio_unitario, subtotal, pedido_id, pedidos(canal, fecha_pedido, estado, medio_pago, total)')
      .eq('lote_codigo', codigo);

    const ventas = (lineas || []).map(l => {
      const p = l.pedidos || {};
      return {
        pedidoId: l.pedido_id,
        canal: p.canal || '',
        fecha: p.fecha_pedido || null,
        estado: p.estado || '',
        medioPago: p.medio_pago || '',
        cantidad: Number(l.cantidad) || 0,
        subtotal: Number(l.subtotal) || 0
      };
    });
    const totalUnidades = ventas.reduce((a, v) => a + v.cantidad, 0);

    return ok({
      success: true,
      etiqueta,
      trazabilidad: {
        sinVentas: ventas.length === 0,
        totalUnidades,
        ventas
      }
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
