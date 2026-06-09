// netlify/functions/sugerencias.js
// PÚBLICO (para el portal del cliente, sin token).
// GET  /api/sugerencias                          → contexto: clima + horario + saludo dinámico
// GET  /api/sugerencias?cross=ID1,ID2            → "los que llevaron esto también llevaron..."
//
// El cross-sell se calcula de las ventas reales (co-ocurrencia de productos en pedidos).

const { supabase, ok, bad, preflight } = require('./_supabase');
const LAT = -32.8908, LON = -68.8272;

function franjaHoraria(h) {
  if (h < 11) return { clave: 'desayuno', titulo: '¡Buen día!', mensaje: 'Arrancá el día con facturas recién horneadas y un café.' };
  if (h < 13) return { clave: 'mediamanana', titulo: 'Media mañana', mensaje: 'El momento perfecto para un cortado con algo dulce.' };
  if (h < 17) return { clave: 'almuerzo', titulo: 'Buenas tardes', mensaje: 'Pan fresco para acompañar el almuerzo.' };
  if (h < 20) return { clave: 'merienda', titulo: '¡Hora de la merienda!', mensaje: 'Llevá facturas y pan dulce para la tarde.' };
  return { clave: 'noche', titulo: 'Buenas noches', mensaje: 'Dejá tu pedido listo para mañana temprano.' };
}

function mensajeClima(tmax, lluvia) {
  if (lluvia > 1) return { icono: '🌧️', mensaje: 'Día de lluvia: nada mejor que quedarse en casa con pan calentito y café.' };
  if (tmax >= 30) return { icono: '☀️', mensaje: 'Día caluroso: probá nuestras opciones más frescas y livianas.' };
  if (tmax <= 12) return { icono: '❄️', mensaje: 'Hace frío: pan recién horneado y algo calentito para entrar en calor.' };
  return { icono: '⛅', mensaje: 'Día ideal para disfrutar de nuestra panadería artesanal.' };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');

  const q = event.queryStringParameters || {};

  // ---- Cross-sell ----
  if (q.cross) {
    const ids = String(q.cross).split(',').map(x => parseInt(x, 10)).filter(Boolean);
    if (!ids.length) return ok({ success: true, sugeridos: [] });
    try {
      // Pedidos que incluyeron alguno de esos productos
      const { data: lineas } = await supabase
        .from('detalle_pedidos').select('pedido_id, producto_id').in('producto_id', ids);
      const pedidoIds = [...new Set((lineas || []).map(l => l.pedido_id))];
      if (!pedidoIds.length) return ok({ success: true, sugeridos: [] });
      // Otros productos de esos pedidos
      const { data: otras } = await supabase
        .from('detalle_pedidos').select('producto_id, nombre').in('pedido_id', pedidoIds);
      const conteo = {};
      (otras || []).forEach(l => {
        if (ids.includes(l.producto_id)) return; // excluir los que ya tiene
        if (!conteo[l.producto_id]) conteo[l.producto_id] = { nombre: l.nombre, veces: 0 };
        conteo[l.producto_id].veces++;
      });
      const sugeridos = Object.entries(conteo)
        .map(([pid, v]) => ({ productoId: Number(pid), nombre: v.nombre, veces: v.veces }))
        .sort((a, b) => b.veces - a.veces).slice(0, 3);
      return ok({ success: true, sugeridos });
    } catch (err) { return bad(500, String(err)); }
  }

  // ---- Contexto (clima + horario) ----
  try {
    const h = (new Date().getUTCHours() - 3 + 24) % 24;
    const franja = franjaHoraria(h);
    let clima = null;
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,precipitation&daily=temperature_2m_max&timezone=America%2FArgentina%2FBuenos_Aires&forecast_days=1`);
      const d = await r.json();
      const tmax = d.daily && d.daily.temperature_2m_max ? d.daily.temperature_2m_max[0] : (d.current ? d.current.temperature_2m : 20);
      const lluvia = d.current ? d.current.precipitation : 0;
      clima = { ...mensajeClima(tmax, lluvia), tmax: Math.round(tmax), temp: d.current ? Math.round(d.current.temperature_2m) : null };
    } catch (e) { /* si falla el clima, seguimos sin él */ }

    return ok({ success: true, franja, clima });
  } catch (err) {
    return bad(500, String(err));
  }
};
