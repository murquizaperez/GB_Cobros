// netlify/functions/catalogo.js
// GET /api/catalogo?canal=minorista|mayorista
// Devuelve los productos activos con el precio que corresponde al canal.

const { supabase, ok, bad, preflight } = require('./_supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');

  const canal = (event.queryStringParameters && event.queryStringParameters.canal) || 'minorista';

  try {
    const { data, error } = await supabase
      .from('productos')
      .select('id, sku, nombre, descripcion, imagen, precio_minorista, precio_mayorista, unidad_bulto, cantidad_minima_bulto, stock')
      .eq('activo', true)
      .order('nombre', { ascending: true });

    if (error) return bad(500, error.message);

    // Normalizamos: la API decide qué precio mostrar según el canal.
    const productos = (data || []).map(p => ({
      id: p.id,
      sku: p.sku,
      nombre: p.nombre,
      descripcion: p.descripcion || '',
      imagen: p.imagen || '',
      precio: canal === 'mayorista' ? Number(p.precio_mayorista) : Number(p.precio_minorista),
      stock: p.stock || 0,
      // Reglas mayoristas (el portal minorista las ignora):
      unidadBulto: p.unidad_bulto || 1,
      cantidadMinimaBulto: p.cantidad_minima_bulto || 1
    }));

    return ok({ success: true, canal, productos });
  } catch (err) {
    return bad(500, String(err));
  }
};
