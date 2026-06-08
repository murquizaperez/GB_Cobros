// netlify/functions/receta.js
// GET  /api/receta?productoId=N&token=...   → ingredientes de la receta
// POST /api/receta  { accion:'set', productoId, items:[{ingredienteId, cantidad}], token }
//      reemplaza la receta completa del producto

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (body && body.token) ||
    (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    const productoId = parseInt((event.queryStringParameters || {}).productoId, 10);
    if (!productoId) return bad(400, 'Falta productoId');
    try {
      const { data, error } = await supabase
        .from('recetas')
        .select('ingrediente_id, cantidad, ingredientes(nombre, unidad, costo_unitario, stock_actual)')
        .eq('producto_id', productoId);
      if (error) return bad(500, error.message);
      return ok({
        success: true,
        items: (data || []).map(r => ({
          ingredienteId: r.ingrediente_id,
          nombre: r.ingredientes ? r.ingredientes.nombre : '',
          unidad: r.ingredientes ? r.ingredientes.unidad : '',
          costo: r.ingredientes ? Number(r.ingredientes.costo_unitario) : 0,
          stock: r.ingredientes ? Number(r.ingredientes.stock_actual) : 0,
          cantidad: Number(r.cantidad)
        }))
      });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return bad(400, 'JSON inválido'); }
    if (!autorizado(event, body)) return bad(401, 'No autorizado');

    const productoId = parseInt(body.productoId, 10);
    if (!productoId) return bad(400, 'Falta productoId');
    const items = Array.isArray(body.items) ? body.items : [];

    try {
      // Reemplazar receta: borrar la anterior e insertar la nueva
      await supabase.from('recetas').delete().eq('producto_id', productoId);
      const filas = items
        .filter(i => i.ingredienteId && Number(i.cantidad) > 0)
        .map(i => ({ producto_id: productoId, ingrediente_id: parseInt(i.ingredienteId, 10), cantidad: Number(i.cantidad) }));
      if (filas.length) {
        const { error } = await supabase.from('recetas').insert(filas);
        if (error) return bad(500, error.message);
      }
      return ok({ success: true, items: filas.length });
    } catch (err) { return bad(500, String(err)); }
  }

  return bad(405, 'Método no permitido');
};
