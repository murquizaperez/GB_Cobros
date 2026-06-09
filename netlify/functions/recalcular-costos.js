// netlify/functions/recalcular-costos.js
// POST /api/recalcular-costos  { token }
// Recalcula el costo_unitario de TODOS los productos con receta, desde el costo
// actual de sus ingredientes. Útil para los productos que vinieron sin costo.

const { ok, bad, preflight } = require('./_supabase');
const { recalcularCostos } = require('./_costos');

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
    const r = await recalcularCostos(null);
    return ok({ success: true, productosActualizados: r.actualizados });
  } catch (err) {
    return bad(500, String(err));
  }
};
