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
      .select('id, codigo_trazabilidad, cantidad_producida, costo_total, responsable, notas, fecha, productos(nombre)')
      .eq('id', id).maybeSingle();
    if (!lote) return bad(404, 'Lote no encontrado');

    const { data: ings } = await supabase
      .from('lote_ingredientes')
      .select('nombre, cantidad, unidad, costo_linea')
      .eq('lote_id', id);

    return ok({
      success: true,
      lote: {
        id: lote.id, codigo: lote.codigo_trazabilidad,
        producto: lote.productos ? lote.productos.nombre : '',
        cantidad: Number(lote.cantidad_producida), costo: Number(lote.costo_total),
        responsable: lote.responsable, notas: lote.notas, fecha: lote.fecha,
        ingredientes: (ings || []).map(i => ({
          nombre: i.nombre, cantidad: Number(i.cantidad), unidad: i.unidad, costo: Number(i.costo_linea)
        }))
      }
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
