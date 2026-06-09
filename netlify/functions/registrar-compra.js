// netlify/functions/registrar-compra.js
// POST /api/registrar-compra  { ingredienteId, cantidad, costoUnitario, proveedor?, token }
//   - suma la cantidad al stock del ingrediente
//   - actualiza su costo_unitario al precio de esta compra
//   - registra la compra en el historial (tabla compras)
//   - recalcula el costo de los productos que usan ese ingrediente
//
// GET /api/registrar-compra?ingredienteId=N&token=...  → historial de precios de ese ingrediente

const { supabase, ok, bad, preflight } = require('./_supabase');
const { recalcularCostos } = require('./_costos');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (body && body.token) ||
    (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  // Historial de precios de un ingrediente
  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    const ingId = parseInt((event.queryStringParameters || {}).ingredienteId, 10);
    if (!ingId) return bad(400, 'Falta ingredienteId');
    try {
      const { data } = await supabase.from('compras')
        .select('cantidad, costo_unitario, total, proveedor, fecha')
        .eq('ingrediente_id', ingId).order('fecha', { ascending: false }).limit(30);
      return ok({ success: true, compras: (data || []).map(c => ({
        cantidad: Number(c.cantidad), costo: Number(c.costo_unitario), total: Number(c.total),
        proveedor: c.proveedor, fecha: c.fecha
      })) });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const ingredienteId = parseInt(body.ingredienteId, 10);
  const cantidad = Number(body.cantidad);
  const costoUnitario = Number(body.costoUnitario);
  if (!ingredienteId) return bad(400, 'Falta ingredienteId');
  if (!cantidad || cantidad <= 0) return bad(400, 'Cantidad inválida');
  if (costoUnitario < 0) return bad(400, 'Costo inválido');

  try {
    const { data: ing } = await supabase.from('ingredientes').select('stock_actual, nombre').eq('id', ingredienteId).maybeSingle();
    if (!ing) return bad(404, 'Ingrediente no encontrado');

    const nuevoStock = (Number(ing.stock_actual) || 0) + cantidad;
    const total = Math.round(cantidad * costoUnitario * 100) / 100;

    // Actualizar stock + costo del ingrediente
    await supabase.from('ingredientes').update({
      stock_actual: nuevoStock, costo_unitario: costoUnitario, actualizado_en: new Date().toISOString()
    }).eq('id', ingredienteId);

    // Registrar la compra
    await supabase.from('compras').insert({
      ingrediente_id: ingredienteId, cantidad, costo_unitario: costoUnitario, total,
      proveedor: String(body.proveedor || '')
    });

    // Recalcular costo de los productos que usan este ingrediente
    const { data: afectados } = await supabase.from('recetas').select('producto_id').eq('ingrediente_id', ingredienteId);
    const ids = [...new Set((afectados || []).map(r => r.producto_id))];
    let recalculo = { actualizados: 0 };
    if (ids.length) recalculo = await recalcularCostos(ids);

    return ok({
      success: true, ingrediente: ing.nombre, nuevoStock,
      nuevoCosto: costoUnitario, productosRecalculados: recalculo.actualizados
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
