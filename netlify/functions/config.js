// netlify/functions/config.js
// GET  /api/config?clave=pos_product_order&token=...
// POST /api/config  { clave, valor, token }

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
    const clave = (event.queryStringParameters || {}).clave;
    if (!clave) return bad(400, 'Falta clave');
    try {
      const { data } = await supabase.from('configuracion').select('valor').eq('clave', clave).maybeSingle();
      return ok({ success: true, clave, valor: data ? data.valor : null });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const clave = String(body.clave || '').trim();
  if (!clave) return bad(400, 'Falta clave');

  try {
    const { error } = await supabase.from('configuracion')
      .upsert({ clave, valor: String(body.valor || '') }, { onConflict: 'clave' });
    if (error) return bad(500, error.message);
    return ok({ success: true });
  } catch (err) {
    return bad(500, String(err));
  }
};
