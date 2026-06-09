// netlify/functions/login.js
// POST /api/login  { pin }
// Valida el PIN contra la tabla usuarios. Si es válido, devuelve nombre, rol
// y el token de acceso (para autorizar el resto de los endpoints).
// Así el ADMIN_TOKEN no se hardcodea en el cliente: se obtiene tras login.

const { supabase, ok, bad, preflight } = require('./_supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }

  const pin = String(body.pin || '').trim();
  if (!pin) return bad(400, 'Falta PIN');

  try {
    const { data: user } = await supabase
      .from('usuarios').select('id, nombre, rol, activo')
      .eq('pin', pin).eq('activo', true).maybeSingle();

    if (!user) return ok({ success: false, error: 'PIN incorrecto' });

    return ok({
      success: true,
      usuario: { id: user.id, nombre: user.nombre, rol: user.rol },
      token: process.env.ADMIN_TOKEN || ''
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
