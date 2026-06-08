// netlify/functions/caja-abrir.js
// POST /api/caja-abrir  { responsable, montoApertura, token }
// Abre una caja nueva. Falla si ya hay una abierta.

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

  try {
    const { data: existe } = await supabase.from('cajas').select('id').eq('estado', 'abierta').maybeSingle();
    if (existe) return bad(409, 'Ya hay una caja abierta. Cerrala antes de abrir otra.');

    const { data, error } = await supabase.from('cajas').insert({
      estado: 'abierta',
      responsable: String(body.responsable || '').trim(),
      monto_apertura: Number(body.montoApertura) || 0
    }).select('id').maybeSingle();
    if (error) return bad(500, error.message);

    return ok({ success: true, cajaId: data && data.id });
  } catch (err) {
    return bad(500, String(err));
  }
};
