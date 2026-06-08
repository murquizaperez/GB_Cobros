// netlify/functions/listar-ingredientes.js
// GET /api/listar-ingredientes?token=...

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

  try {
    const { data, error } = await supabase
      .from('ingredientes')
      .select('id, nombre, unidad, stock_actual, stock_minimo, costo_unitario, activo')
      .order('nombre');
    if (error) return bad(500, error.message);

    return ok({
      success: true,
      ingredientes: (data || []).map(i => ({
        id: i.id, nombre: i.nombre, unidad: i.unidad,
        stock: Number(i.stock_actual), stockMinimo: Number(i.stock_minimo),
        costo: Number(i.costo_unitario), activo: i.activo,
        bajo: Number(i.stock_actual) <= Number(i.stock_minimo)
      }))
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
