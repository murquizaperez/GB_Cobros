// netlify/functions/caja-cerrar.js
// POST /api/caja-cerrar  { montoContado, token }
// Cierra la caja abierta. Calcula esperado vs contado (diferencia de arqueo).

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
    const { data: caja } = await supabase.from('cajas').select('*').eq('estado', 'abierta')
      .order('abierta_en', { ascending: false }).maybeSingle();
    if (!caja) return bad(404, 'No hay caja abierta');

    const { data: movs } = await supabase.from('movimientos_caja').select('tipo, monto').eq('caja_id', caja.id);
    let ventas = 0, ingresos = 0, egresos = 0;
    (movs || []).forEach(m => {
      const mt = Number(m.monto) || 0;
      if (m.tipo === 'venta') ventas += mt;
      else if (m.tipo === 'ingreso') ingresos += mt;
      else if (m.tipo === 'egreso') egresos += mt;
    });
    const esperado = Number(caja.monto_apertura) + ventas + ingresos - egresos;
    const contado = body.montoContado != null ? Number(body.montoContado) : esperado;

    const { error } = await supabase.from('cajas').update({
      estado: 'cerrada',
      monto_cierre: contado,
      total_ventas: ventas,
      cerrada_en: new Date().toISOString()
    }).eq('id', caja.id);
    if (error) return bad(500, error.message);

    return ok({
      success: true,
      resumen: { apertura: Number(caja.monto_apertura), ventas, ingresos, egresos, esperado, contado, diferencia: contado - esperado }
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
