// netlify/functions/producir.js
// POST /api/producir  { productoId, cantidad, responsable?, notas?, token }
// Registra un lote de producción:
//   - lee la receta del producto
//   - descuenta cada ingrediente (cantidad_receta * cantidad_producida)
//   - suma stock del producto terminado
//   - calcula el costo del lote
//   - guarda el lote en lotes_produccion
//
// GET /api/producir?token=...  → historial de lotes recientes

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

  // Historial de lotes
  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    try {
      const { data } = await supabase
        .from('lotes_produccion')
        .select('id, cantidad_producida, costo_total, ingredientes_ok, responsable, notas, fecha, productos(nombre)')
        .order('fecha', { ascending: false }).limit(40);
      return ok({
        success: true,
        lotes: (data || []).map(l => ({
          id: l.id, producto: l.productos ? l.productos.nombre : '',
          cantidad: Number(l.cantidad_producida), costo: Number(l.costo_total),
          ingredientesOk: l.ingredientes_ok, responsable: l.responsable, notas: l.notas, fecha: l.fecha
        }))
      });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const productoId = parseInt(body.productoId, 10);
  const cantidad = Number(body.cantidad);
  if (!productoId) return bad(400, 'Falta productoId');
  if (!cantidad || cantidad <= 0) return bad(400, 'Cantidad inválida');

  try {
    // Producto
    const { data: prod } = await supabase.from('productos').select('id, nombre, stock').eq('id', productoId).maybeSingle();
    if (!prod) return bad(404, 'Producto no encontrado');

    // Receta
    const { data: receta } = await supabase
      .from('recetas')
      .select('ingrediente_id, cantidad, ingredientes(nombre, stock_actual, costo_unitario)')
      .eq('producto_id', productoId);

    let costoTotal = 0;
    const faltantes = [];
    const descuentos = [];

    (receta || []).forEach(r => {
      const necesita = Number(r.cantidad) * cantidad;
      const ing = r.ingredientes || {};
      const disp = Number(ing.stock_actual) || 0;
      costoTotal += necesita * (Number(ing.costo_unitario) || 0);
      if (disp < necesita) faltantes.push({ nombre: ing.nombre, necesita, disponible: disp });
      descuentos.push({ id: r.ingrediente_id, nuevo: Math.max(0, disp - necesita) });
    });

    // Si faltan ingredientes y no se forzó, avisar sin producir
    if (faltantes.length && !body.forzar) {
      return ok({ success: false, faltantes, mensaje: 'No alcanza la materia prima para este lote' });
    }

    // Descontar ingredientes
    for (const d of descuentos) {
      await supabase.from('ingredientes').update({ stock_actual: d.nuevo, actualizado_en: new Date().toISOString() }).eq('id', d.id);
    }

    // Sumar stock del producto terminado
    const nuevoStock = (Number(prod.stock) || 0) + cantidad;
    await supabase.from('productos').update({ stock: nuevoStock }).eq('id', productoId);

    // Registrar el lote
    const { data: lote } = await supabase.from('lotes_produccion').insert({
      producto_id: productoId, cantidad_producida: cantidad, costo_total: costoTotal,
      ingredientes_ok: (receta || []).length > 0,
      responsable: String(body.responsable || ''), notas: String(body.notas || '')
    }).select('id').maybeSingle();

    return ok({
      success: true, loteId: lote && lote.id, producto: prod.nombre,
      cantidad, nuevoStock, costoLote: costoTotal,
      ingredientesDescontados: descuentos.length,
      sinReceta: (receta || []).length === 0
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
