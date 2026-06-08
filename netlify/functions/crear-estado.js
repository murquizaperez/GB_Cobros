// netlify/functions/caja-estado.js
// GET /api/caja-estado?token=...
// Devuelve la caja abierta (si hay) con ventas del turno y desglose.

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event)) return bad(401, 'No autorizado');

  try {
    const { data: caja } = await supabase
      .from('cajas').select('*').eq('estado', 'abierta')
      .order('abierta_en', { ascending: false }).maybeSingle();

    if (!caja) return ok({ success: true, abierta: false });

    // Movimientos de esta caja
    const { data: movs } = await supabase
      .from('movimientos_caja').select('tipo, monto, concepto, creado_en')
      .eq('caja_id', caja.id).order('creado_en', { ascending: false });

    let ventas = 0, ingresos = 0, egresos = 0, nVentas = 0;
    (movs || []).forEach(m => {
      const mt = Number(m.monto) || 0;
      if (m.tipo === 'venta') { ventas += mt; nVentas++; }
      else if (m.tipo === 'ingreso') ingresos += mt;
      else if (m.tipo === 'egreso') egresos += mt;
    });
    const esperadoEnCaja = Number(caja.monto_apertura) + ventas + ingresos - egresos;

    return ok({
      success: true, abierta: true,
      caja: {
        id: caja.id, responsable: caja.responsable, apertura: Number(caja.monto_apertura),
        abiertaEn: caja.abierta_en, ventas, nVentas, ingresos, egresos, esperadoEnCaja
      },
      movimientos: (movs || []).slice(0, 30).map(m => ({ tipo: m.tipo, monto: Number(m.monto), concepto: m.concepto, fecha: m.creado_en }))
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
