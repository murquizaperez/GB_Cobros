// netlify/functions/gestionar-ingrediente.js
// POST /api/gestionar-ingrediente
//   "crear"         { nombre, unidad, stock, stockMinimo, costo }
//   "editar"        { id, nombre?, unidad?, stockMinimo?, costo?, activo? }
//   "ajustar_stock" { id, delta }   (suma materia prima recibida, p.ej.)
//   "set_stock"     { id, stock }
//   "borrar"        { id }

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
      if (!body.nombre) return bad(400, 'Falta nombre');
      const { data, error } = await supabase.from('ingredientes').insert({
        nombre: String(body.nombre).trim(),
        unidad: String(body.unidad || 'g'),
        stock_actual: Number(body.stock) || 0,
        stock_minimo: Number(body.stockMinimo) || 0,
        costo_unitario: Number(body.costo) || 0,
        activo: body.activo !== false
      }).select('id').maybeSingle();
      if (error) return bad(500, error.message);
      return ok({ success: true, id: data && data.id });
    }

    const id = parseInt(body.id, 10);
    if (!id) return bad(400, 'Falta id');

    if (accion === 'borrar') {
      const { error } = await supabase.from('ingredientes').delete().eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }

    if (accion === 'editar') {
      const upd = { actualizado_en: new Date().toISOString() };
      if (body.nombre !== undefined) upd.nombre = String(body.nombre).trim();
      if (body.unidad !== undefined) upd.unidad = String(body.unidad);
      if (body.stockMinimo !== undefined) upd.stock_minimo = Number(body.stockMinimo) || 0;
      if (body.costo !== undefined) upd.costo_unitario = Number(body.costo) || 0;
      if (body.activo !== undefined) upd.activo = !!body.activo;
      const { error } = await supabase.from('ingredientes').update(upd).eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }

    if (accion === 'ajustar_stock' || accion === 'set_stock') {
      const { data: ing } = await supabase.from('ingredientes').select('stock_actual').eq('id', id).maybeSingle();
      if (!ing) return bad(404, 'Ingrediente no encontrado');
      let nuevo = accion === 'set_stock' ? (Number(body.stock) || 0) : (Number(ing.stock_actual) || 0) + (Number(body.delta) || 0);
      if (nuevo < 0) nuevo = 0;
      const { error } = await supabase.from('ingredientes').update({ stock_actual: nuevo, actualizado_en: new Date().toISOString() }).eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true, stock: nuevo });
    }

    return bad(400, 'Acción inválida');
  } catch (err) {
    return bad(500, String(err));
  }
};
