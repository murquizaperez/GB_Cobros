// netlify/functions/lote.js
// GET /api/lote?id=N&token=...
// Ficha de trazabilidad de un lote: datos del lote, receta vs uso real por
// ingrediente, y las VENTAS VINCULADAS (líneas de detalle_pedidos con ese
// lote_codigo). Es lo que consume App.verLote() y App.etiquetaLote().
//
// Requiere las columnas lote_id / lote_codigo en detalle_pedidos
// (migracion-trazabilidad.sql) para que aparezcan las ventas.

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const qs = event.queryStringParameters || {};
  const got = (event.headers['x-admin-token'] || qs.token || '').trim();
  return got === need;
}
function minutosEntre(ini, fin) {
  if (!ini || !fin) return null;
  return Math.max(0, Math.round((new Date(fin) - new Date(ini)) / 60000));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event)) return bad(401, 'No autorizado');

  const id = parseInt((event.queryStringParameters || {}).id, 10);
  if (!id) return bad(400, 'Falta id');

  try {
    const { data: l } = await supabase
      .from('lotes_produccion')
      .select('id, codigo_trazabilidad, cantidad_producida, cantidad_esperada, costo_total, costo_teorico, estado, empleado, responsable, notas, fecha, hora_inicio, hora_fin, productos(nombre)')
      .eq('id', id).maybeSingle();
    if (!l) return bad(404, 'Lote no encontrado');

    // Receta vs uso real por ingrediente
    const { data: li } = await supabase
      .from('lote_ingredientes')
      .select('nombre, cantidad, unidad, costo_linea, cantidad_real, desvio, costo_real')
      .eq('lote_id', id);
    const ingredientes = (li || []).map(i => ({
      nombre: i.nombre,
      teorico: Number(i.cantidad) || 0,
      unidad: i.unidad || '',
      real: i.cantidad_real == null ? null : Number(i.cantidad_real),
      desvio: i.desvio == null ? null : Number(i.desvio),
      costo: Number(i.costo_linea) || 0,
      costoReal: i.costo_real == null ? null : Number(i.costo_real)
    }));

    // Ventas vinculadas (qué ventas usaron este lote)
    const codigo = l.codigo_trazabilidad;
    let ventas = [];
    if (codigo) {
      const { data: dv } = await supabase
        .from('detalle_pedidos')
        .select('cantidad, subtotal, pedido_id, pedidos(canal, fecha_pedido, estado, medio_pago)')
        .eq('lote_codigo', codigo);
      ventas = (dv || []).map(v => {
        const p = v.pedidos || {};
        return {
          pedidoId: v.pedido_id,
          canal: p.canal || '',
          fecha: p.fecha_pedido || null,
          estado: p.estado || '',
          medioPago: p.medio_pago || '',
          cantidad: Number(v.cantidad) || 0,
          subtotal: Number(v.subtotal) || 0
        };
      });
    }
    const unidadesVendidas = ventas.reduce((a, v) => a + v.cantidad, 0);

    const esperada = l.cantidad_esperada == null ? null : Number(l.cantidad_esperada);
    const real = Number(l.cantidad_producida) || 0;

    return ok({
      success: true,
      lote: {
        id: l.id,
        codigo,
        producto: l.productos ? l.productos.nombre : '',
        estado: l.estado || 'finalizado',
        fecha: l.hora_fin || l.fecha,
        responsable: l.responsable || l.empleado || '',
        empleado: l.empleado || '',
        cantidadEsperada: esperada,
        cantidad: real,
        diferencia: esperada == null ? null : real - esperada,
        tiempoMin: minutosEntre(l.hora_inicio, l.hora_fin),
        costo: Number(l.costo_total) || 0,
        costoTeorico: l.costo_teorico == null ? null : Number(l.costo_teorico),
        notas: l.notas || '',
        ingredientes,
        ventas,
        unidadesVendidas
      }
    });
  } catch (err) { return bad(500, String(err)); }
};
