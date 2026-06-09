// netlify/functions/usuarios.js
// GET  /api/usuarios?token=...                      → lista usuarios
// POST /api/usuarios  { accion, ... , token }
//   "crear"  { nombre, pin, rol }
//   "editar" { id, nombre?, pin?, rol?, activo? }
//   "borrar" { id }

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
    try {
      const { data, error } = await supabase.from('usuarios')
        .select('id, nombre, rol, activo, creado_en').order('nombre');
      if (error) return bad(500, error.message);
      return ok({ success: true, usuarios: data || [] });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const accion = body.accion;
  try {
    if (accion === 'crear') {
      if (!body.nombre || !body.pin) return bad(400, 'Falta nombre o PIN');
      const rol = ['dueño', 'cajero'].includes(body.rol) ? body.rol : 'cajero';
      const { error } = await supabase.from('usuarios').insert({
        nombre: String(body.nombre).trim(), pin: String(body.pin).trim(), rol
      });
      if (error) return bad(500, error.message.includes('idx_usuarios_pin') ? 'Ese PIN ya está en uso' : error.message);
      return ok({ success: true });
    }

    const id = parseInt(body.id, 10);
    if (!id) return bad(400, 'Falta id');

    if (accion === 'borrar') {
      const { error } = await supabase.from('usuarios').delete().eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }

    if (accion === 'editar') {
      const upd = {};
      if (body.nombre !== undefined) upd.nombre = String(body.nombre).trim();
      if (body.pin !== undefined) upd.pin = String(body.pin).trim();
      if (body.rol !== undefined && ['dueño', 'cajero'].includes(body.rol)) upd.rol = body.rol;
      if (body.activo !== undefined) upd.activo = !!body.activo;
      const { error } = await supabase.from('usuarios').update(upd).eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }

    return bad(400, 'Acción inválida');
  } catch (err) {
    return bad(500, String(err));
  }
};
