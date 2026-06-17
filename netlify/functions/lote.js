// netlify/functions/lote.js
// GET /api/lote?id=N&token=...  → ficha de trazabilidad de un lote:
//   producto, cantidad, código, fecha, y los ingredientes consumidos con cantidad y costo.

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event)) return bad(401, 'No autorizado');

  const id = parseInt((event.queryStringParameters || {}).id, 10);
  if (!id) return bad(400, 'Falta id');

  try {
    const { data: lote } = await supabase
      .from('lotes_produccion')
      .select('id, codigo_trazabilidad, cantidad_producida, cantidad_esperada, costo_total, costo_teorico, estado, empleado, responsable, notas, fecha, hora_inicio, hora_fin, productos(nombre)')
      .eq('id', id).maybeSingle();
    if (!lote) return bad(404, 'Lote no encontrado');

    const { data: ings } = await supabase
      .from('lote_ingredientes')
      .select('nombre, cantidad, unidad, costo_linea, cantidad_real, desvio, costo_real')
      .eq('lote_id', id);

    return ok({
      success: true,
      lote: {
        id: lote.id, codigo: lote.codigo_trazabilidad,
        producto: lote.productos ? lote.productos.nombre : '',
        estado: lote.estado || 'finalizado',
        cantidad: Number(lote.cantidad_producida),
        cantidadEsperada: lote.cantidad_esperada == null ? null : Number(lote.cantidad_esperada),
        diferencia: (lote.estado !== 'en_proceso' && lote.cantidad_esperada != null)
          ? Number(lote.cantidad_producida) - Number(lote.cantidad_esperada) : null,
        tiempoMin: (lote.hora_inicio && lote.hora_fin)
          ? Math.max(0, Math.round((new Date(lote.hora_fin) - new Date(lote.hora_inicio)) / 60000)) : null,
        costo: Number(lote.costo_total),
        costoTeorico: lote.costo_teorico == null ? null : Number(lote.costo_teorico),
        empleado: lote.empleado || lote.responsable || '',
        responsable: lote.responsable || lote.empleado || '', notas: lote.notas, fecha: lote.fecha,
        ingredientes: (ings || []).map(i => ({
          nombre: i.nombre, unidad: i.unidad,
          teorico: Number(i.cantidad),
          cantidad: Number(i.cantidad), // compat
          real: i.cantidad_real == null ? null : Number(i.cantidad_real),
          desvio: i.desvio == null ? null : Number(i.desvio),
          costo: Number(i.costo_linea),
          costoReal: i.costo_real == null ? null : Number(i.costo_real)
        }))
      }
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
