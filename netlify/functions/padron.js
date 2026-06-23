// netlify/functions/padron.js
// GET /api/padron?cuit=30719069068&token=...
//   Trae del padrón de AFIP (constancia de inscripción) la razón social, domicilio
//   y condición de IVA de un CUIT, para autocompletar el alta de cliente / checkout.
//   Devuelve { success, datos } o { success:false, error }.

const { ok, bad, preflight } = require('./_supabase');
const { consultarPadron } = require('./_arca');

function autorizado(event) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const qs = event.queryStringParameters || {};
  const got = (event.headers['x-admin-token'] || qs.token || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event)) return bad(401, 'No autorizado');

  const qs = event.queryStringParameters || {};
  const cuit = String(qs.cuit || '').replace(/\D/g, '');
  if (cuit.length !== 11) return bad(400, 'CUIT inválido (11 dígitos)');

  try {
    const datos = await consultarPadron(cuit);
    if (!datos) return ok({ success: false, error: 'No se encontró el CUIT en el padrón' });
    return ok({ success: true, datos });
  } catch (e) {
    return ok({ success: false, error: e.message || 'Error consultando el padrón' });
  }
};
