// netlify/functions/listar-productos.js
// GET /api/listar-productos?token=...
// Trae TODOS los productos (activos e inactivos) para el módulo de gestión/stock.

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
      .from('productos')
      .select('id, sku, nombre, descripcion, precio_minorista, precio_mayorista, costo_unitario, stock, activo, imagen')
      .order('nombre');
    if (error) return bad(500, error.message);

    return ok({
      success: true,
      productos: (data || []).map(p => ({
        id: p.id, sku: p.sku, nombre: p.nombre, descripcion: p.descripcion || '',
        precioMinorista: Number(p.precio_minorista), precioMayorista: Number(p.precio_mayorista),
        costo: Number(p.costo_unitario || 0), stock: Number(p.stock), activo: p.activo, imagen: p.imagen || ''
      }))
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
