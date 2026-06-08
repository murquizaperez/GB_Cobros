// netlify/functions/gestionar-producto.js
// POST /api/gestionar-producto
// Acciones (campo "accion"):
//   "editar"        { id, nombre?, descripcion?, precioMinorista?, precioMayorista?, costo?, activo?, imagen? }
//   "ajustar_stock" { id, delta }     suma/resta stock (delta puede ser negativo)
//   "set_stock"     { id, stock }     fija el stock a un valor
//   "crear"         { sku, nombre, precioMinorista, ... }

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (body && body.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const accion = body.accion;

  try {
    if (accion === 'crear') {
      const sku = String(body.sku || '').trim() || ('PROD-' + Date.now());
      if (!body.nombre) return bad(400, 'Falta nombre');
      const { data, error } = await supabase.from('productos').insert({
        sku, nombre: String(body.nombre).trim(), descripcion: String(body.descripcion || ''),
        precio_minorista: Number(body.precioMinorista) || 0,
        precio_mayorista: Number(body.precioMayorista) || 0,
        costo_unitario: Number(body.costo) || 0,
        stock: Number(body.stock) || 0,
        activo: body.activo !== false,
        imagen: String(body.imagen || '')
      }).select('id').maybeSingle();
      if (error) return bad(500, error.message);
      return ok({ success: true, id: data && data.id });
    }

    const id = parseInt(body.id, 10);
    if (!id) return bad(400, 'Falta id');

    if (accion === 'editar') {
      const upd = {};
      if (body.nombre !== undefined) upd.nombre = String(body.nombre).trim();
      if (body.descripcion !== undefined) upd.descripcion = String(body.descripcion);
      if (body.precioMinorista !== undefined) upd.precio_minorista = Number(body.precioMinorista) || 0;
      if (body.precioMayorista !== undefined) upd.precio_mayorista = Number(body.precioMayorista) || 0;
      if (body.costo !== undefined) upd.costo_unitario = Number(body.costo) || 0;
      if (body.activo !== undefined) upd.activo = !!body.activo;
      if (body.imagen !== undefined) upd.imagen = String(body.imagen);
      const { error } = await supabase.from('productos').update(upd).eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }

    if (accion === 'ajustar_stock' || accion === 'set_stock') {
      const { data: prod } = await supabase.from('productos').select('stock').eq('id', id).maybeSingle();
      if (!prod) return bad(404, 'Producto no encontrado');
      let nuevo;
      if (accion === 'set_stock') nuevo = Number(body.stock) || 0;
      else nuevo = (Number(prod.stock) || 0) + (Number(body.delta) || 0);
      if (nuevo < 0) nuevo = 0;
      const { error } = await supabase.from('productos').update({ stock: nuevo }).eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true, stock: nuevo });
    }

    return bad(400, 'Acción inválida');
  } catch (err) {
    return bad(500, String(err));
  }
};
