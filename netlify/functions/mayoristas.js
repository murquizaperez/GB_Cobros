// netlify/functions/mayoristas.js
// Gestión (admin) de clientes mayoristas y sus listas de precio.
// GET  /api/mayoristas?token=...                  → lista de clientes
// GET  /api/mayoristas?clienteId=N&token=...       → cliente + sus precios + catálogo base
// POST /api/mayoristas  { accion, ..., token }
//   crear   { nombre, contacto?, telefono?, codigoAcceso }
//   editar  { id, nombre?, contacto?, telefono?, codigoAcceso?, activo? }
//   borrar  { id }
//   precios { id (cliente), precios:[{productoId, precio}] }   ← setea/actualiza lista

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
    const clienteId = parseInt((event.queryStringParameters || {}).clienteId, 10);
    try {
      if (clienteId) {
        const { data: cli } = await supabase.from('clientes_mayoristas')
          .select('*').eq('id', clienteId).maybeSingle();
        const { data: productos } = await supabase.from('productos')
          .select('id, nombre, precio_minorista, precio_mayorista').eq('activo', true).order('nombre');
        const { data: precios } = await supabase.from('precios_mayoristas')
          .select('producto_id, precio').eq('cliente_id', clienteId);
        const mapaPrecio = {};
        (precios || []).forEach(p => { mapaPrecio[p.producto_id] = Number(p.precio); });
        return ok({
          success: true, cliente: cli,
          productos: (productos || []).map(p => ({
            id: p.id, nombre: p.nombre,
            precioMinorista: Number(p.precio_minorista) || 0,
            precioMayorista: Number(p.precio_mayorista) || 0,
            precioCliente: mapaPrecio[p.id] !== undefined ? mapaPrecio[p.id] : null
          }))
        });
      }
      const { data } = await supabase.from('clientes_mayoristas')
        .select('id, nombre, contacto, telefono, codigo_acceso, activo').order('nombre');
      return ok({ success: true, clientes: data || [] });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  try {
    const accion = body.accion;

    if (accion === 'crear') {
      if (!body.nombre || !body.codigoAcceso) return bad(400, 'Falta nombre o código de acceso');
      const { error } = await supabase.from('clientes_mayoristas').insert({
        nombre: String(body.nombre).trim(), contacto: String(body.contacto || ''),
        telefono: String(body.telefono || ''), codigo_acceso: String(body.codigoAcceso).trim()
      });
      if (error) return bad(500, error.message.includes('idx_clientes_may_codigo') ? 'Ese código ya está en uso' : error.message);
      return ok({ success: true });
    }

    const id = parseInt(body.id, 10);
    if (!id) return bad(400, 'Falta id');

    if (accion === 'borrar') {
      const { error } = await supabase.from('clientes_mayoristas').delete().eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }

    if (accion === 'editar') {
      const upd = {};
      if (body.nombre !== undefined) upd.nombre = String(body.nombre).trim();
      if (body.contacto !== undefined) upd.contacto = String(body.contacto);
      if (body.telefono !== undefined) upd.telefono = String(body.telefono);
      if (body.codigoAcceso !== undefined) upd.codigo_acceso = String(body.codigoAcceso).trim();
      if (body.activo !== undefined) upd.activo = !!body.activo;
      const { error } = await supabase.from('clientes_mayoristas').update(upd).eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }

    if (accion === 'precios') {
      const precios = Array.isArray(body.precios) ? body.precios : [];
      // upsert de cada precio; si precio<=0, borrar la fila (vuelve al precio general)
      for (const p of precios) {
        const pid = parseInt(p.productoId, 10);
        const precio = Number(p.precio);
        if (!pid) continue;
        if (precio > 0) {
          await supabase.from('precios_mayoristas')
            .upsert({ cliente_id: id, producto_id: pid, precio }, { onConflict: 'cliente_id,producto_id' });
        } else {
          await supabase.from('precios_mayoristas').delete().eq('cliente_id', id).eq('producto_id', pid);
        }
      }
      return ok({ success: true });
    }

    return bad(400, 'Acción inválida');
  } catch (err) {
    return bad(500, String(err));
  }
};
