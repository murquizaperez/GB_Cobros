// netlify/functions/reposicion.js
// GET  /api/reposicion?dias=60&lead=3&colchon=2&cobertura=10&token=...
//   Punto de reposición dinámico por insumo, calculado con el consumo real
//   (lote_ingredientes.cantidad_real de los lotes finalizados del período).
//     consumoDiario   = uso real total / días del período
//     puntoReposicion = consumoDiario × (lead + colchón)        ← mínimo sugerido
//     objetivoCompra  = consumoDiario × cobertura               ← nivel al que reponer
//     diasRestantes   = stock_actual / consumoDiario            ← cuánto falta para quedarte sin
//   Marca alerta cuando stock_actual ≤ puntoReposicion y sugiere cuánto comprar.
//
// POST /api/reposicion   { aplicar:[{ingredienteId, minimo}], token }
//   Aplica los mínimos sugeridos (actualiza ingredientes.stock_minimo).
//
// Solo lectura en GET. No requiere migración.

const { supabase, ok, bad, preflight } = require('./_supabase');
const { valorStock } = require('./_unidades');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const qs = event.queryStringParameters || {};
  const got = (event.headers['x-admin-token'] || (body && body.token) || qs.token || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  // ---------- POST: aplicar mínimos ----------
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return bad(400, 'JSON inválido'); }
    if (!autorizado(event, body)) return bad(401, 'No autorizado');
    const aplicar = (Array.isArray(body.aplicar) ? body.aplicar : [])
      .map(a => ({ id: parseInt(a.ingredienteId, 10), minimo: Number(a.minimo) }))
      .filter(a => a.id && a.minimo >= 0);
    if (!aplicar.length) return bad(400, 'Nada para aplicar');
    try {
      let n = 0;
      for (const a of aplicar) {
        const { error } = await supabase.from('ingredientes').update({ stock_minimo: Math.round(a.minimo) }).eq('id', a.id);
        if (!error) n++;
      }
      return ok({ success: true, actualizados: n });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event, null)) return bad(401, 'No autorizado');

  const qs = event.queryStringParameters || {};
  const dias = Math.min(parseInt(qs.dias || '60', 10) || 60, 365);
  const lead = Math.max(0, Number(qs.lead) || 3);          // días de demora del proveedor
  const colchon = Math.max(0, Number(qs.colchon) || 2);    // días de seguridad
  const cobertura = Math.max(1, Number(qs.cobertura) || (lead + colchon + 7)); // a cuántos días reponer

  try {
    const desde = new Date(Date.now() - dias * 864e5).toISOString();

    // Lotes finalizados del período → para acotar el consumo real
    const { data: lotes } = await supabase
      .from('lotes_produccion').select('id').eq('estado', 'finalizado').gte('fecha', desde);
    const loteIds = (lotes || []).map(l => l.id);

    // Uso real de insumos en esos lotes
    const consumo = {}; // ingredienteId|nombre -> unidades reales
    if (loteIds.length) {
      const { data: li } = await supabase
        .from('lote_ingredientes')
        .select('ingrediente_id, nombre, cantidad_real')
        .in('lote_id', loteIds);
      (li || []).forEach(r => {
        if (r.cantidad_real == null) return;
        const key = r.ingrediente_id != null ? ('id:' + r.ingrediente_id) : ('n:' + String(r.nombre || '').toLowerCase().trim());
        consumo[key] = (consumo[key] || 0) + (Number(r.cantidad_real) || 0);
      });
    }

    // Insumos activos
    const { data: ings } = await supabase
      .from('ingredientes').select('id, nombre, unidad, stock_actual, stock_minimo, costo_unitario, activo')
      .eq('activo', true);

    const items = (ings || []).map(g => {
      const byId = consumo['id:' + g.id];
      const byName = consumo['n:' + String(g.nombre || '').toLowerCase().trim()];
      const consumoTotal = (byId != null ? byId : 0) + (byId == null && byName != null ? byName : 0);
      const consumoDiario = consumoTotal / dias;
      const stock = Number(g.stock_actual) || 0;
      const rop = consumoDiario * (lead + colchon);
      const objetivo = consumoDiario * cobertura;
      const diasRestantes = consumoDiario > 0 ? Math.round(stock / consumoDiario * 10) / 10 : null;
      const alerta = consumoDiario > 0 && stock <= rop;
      const sugeridoComprar = alerta ? Math.max(0, Math.round(objetivo - stock)) : 0;
      return {
        ingredienteId: g.id, nombre: g.nombre, unidad: g.unidad,
        stock, minimoActual: Number(g.stock_minimo) || 0,
        consumoDiario: Math.round(consumoDiario * 100) / 100,
        minimoSugerido: Math.round(rop),
        objetivoCompra: Math.round(objetivo),
        diasRestantes, alerta, sinConsumo: consumoDiario === 0,
        sugeridoComprar,
        costoCompra: Math.round(valorStock(sugeridoComprar, g.costo_unitario, g.unidad))
      };
    }).sort((a, b) => {
      // primero los que se quedan sin stock antes
      const da = a.diasRestantes == null ? 1e9 : a.diasRestantes;
      const db = b.diasRestantes == null ? 1e9 : b.diasRestantes;
      return da - db;
    });

    const alertas = items.filter(i => i.alerta).length;
    const costoTotalCompra = items.reduce((s, i) => s + (i.costoCompra || 0), 0);

    return ok({
      success: true,
      dias, lead, colchon, cobertura,
      alertas, costoTotalCompra,
      items
    });
  } catch (err) { return bad(500, String(err)); }
};
