// netlify/functions/analisis-produccion.js
// GET /api/analisis-produccion?dias=90&token=...
// Agrega los lotes finalizados del período para detectar:
//   • driftIngredientes: ingredientes que se van sistemáticamente de la receta
//     (real vs teórico acumulado). Drift + = se usa de más (receta corta o desperdicio).
//   • rendimiento: por producto, cuánto se produce vs lo esperado y el desvío de costo
//     (costo real del lote vs costo teórico).
// Solo lectura. No requiere migración (usa lotes_produccion + lote_ingredientes).

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

  const dias = Math.min(parseInt((event.queryStringParameters || {}).dias || '90', 10) || 90, 365);
  const desde = new Date(Date.now() - dias * 864e5).toISOString();

  try {
    // Lotes finalizados del período
    const { data: lotes } = await supabase
      .from('lotes_produccion')
      .select('id, producto_id, cantidad_producida, cantidad_esperada, costo_total, costo_teorico, fecha, productos(nombre)')
      .eq('estado', 'finalizado').gte('fecha', desde)
      .order('fecha', { ascending: false });

    const loteIds = (lotes || []).map(l => l.id);
    if (!loteIds.length) {
      return ok({ success: true, dias, lotesAnalizados: 0, rendimiento: [], driftIngredientes: [] });
    }

    // Líneas de ingrediente de esos lotes
    const { data: li } = await supabase
      .from('lote_ingredientes')
      .select('lote_id, nombre, unidad, cantidad, cantidad_real, desvio, costo_linea, costo_real')
      .in('lote_id', loteIds);

    // ---- Rendimiento por producto ----
    const prod = {};
    (lotes || []).forEach(l => {
      const id = l.producto_id;
      if (!prod[id]) prod[id] = {
        productoId: id, nombre: l.productos ? l.productos.nombre : '',
        lotes: 0, esperadaTotal: 0, producidaTotal: 0,
        sumCostoTeo: 0, sumCostoReal: 0
      };
      const p = prod[id];
      p.lotes += 1;
      const esp = Number(l.cantidad_esperada) || 0;
      const real = Number(l.cantidad_producida) || 0;
      if (esp > 0) { p.esperadaTotal += esp; p.producidaTotal += real; }
      p.sumCostoTeo += Number(l.costo_teorico) || 0;
      p.sumCostoReal += Number(l.costo_total) || 0;
    });
    const rendimiento = Object.values(prod).map(p => {
      const rendimientoPct = p.esperadaTotal > 0 ? Math.round(p.producidaTotal / p.esperadaTotal * 1000) / 10 : null;
      const desvioCostoProm = p.lotes ? Math.round((p.sumCostoReal - p.sumCostoTeo) / p.lotes) : 0;
      return {
        productoId: p.productoId, nombre: p.nombre, lotes: p.lotes,
        esperadaTotal: p.esperadaTotal, producidaTotal: p.producidaTotal,
        rendimientoPct,
        costoTeoricoProm: p.lotes ? Math.round(p.sumCostoTeo / p.lotes) : 0,
        costoRealProm: p.lotes ? Math.round(p.sumCostoReal / p.lotes) : 0,
        desvioCostoProm
      };
    }).sort((a, b) => (a.rendimientoPct == null ? 999 : a.rendimientoPct) - (b.rendimientoPct == null ? 999 : b.rendimientoPct));

    // ---- Drift por ingrediente ----
    const ing = {};
    (li || []).forEach(r => {
      if (r.cantidad_real == null) return;            // sin uso real cargado, no aporta señal
      const key = (r.nombre || '').toLowerCase().trim();
      if (!key) return;
      if (!ing[key]) ing[key] = {
        nombre: r.nombre, unidad: r.unidad || '', lotes: 0,
        teoricoTotal: 0, realTotal: 0, sumCostoTeo: 0, sumCostoReal: 0
      };
      const g = ing[key];
      g.lotes += 1;
      const teo = Number(r.cantidad) || 0;
      const real = Number(r.cantidad_real) || 0;
      g.teoricoTotal += teo;
      g.realTotal += real;
      g.sumCostoTeo += Number(r.costo_linea) || 0;
      g.sumCostoReal += (r.costo_real != null ? Number(r.costo_real) : Number(r.costo_linea)) || 0;
    });
    const driftIngredientes = Object.values(ing).map(g => {
      const driftPct = g.teoricoTotal > 0 ? Math.round((g.realTotal - g.teoricoTotal) / g.teoricoTotal * 1000) / 10 : 0;
      return {
        nombre: g.nombre, unidad: g.unidad, lotes: g.lotes,
        teoricoTotal: Math.round(g.teoricoTotal * 100) / 100,
        realTotal: Math.round(g.realTotal * 100) / 100,
        driftPct,
        extraCostoTotal: Math.round(g.sumCostoReal - g.sumCostoTeo)
      };
    }).sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));

    return ok({ success: true, dias, lotesAnalizados: loteIds.length, rendimiento, driftIngredientes });
  } catch (err) { return bad(500, String(err)); }
};
