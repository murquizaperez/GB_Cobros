// netlify/functions/dashboard.js
// GET /api/dashboard?token=...
// KPIs del sistema: ventas hoy/semana/mes, pedidos pendientes, totales.

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
    const ahora = new Date();
    const hoy0 = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).toISOString();
    const semana0 = new Date(ahora.getTime() - 7 * 864e5).toISOString();
    const mes0 = new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString();

    // Pedidos pagados (para ventas) — traemos los del mes y agrupamos en JS
    const { data: pagados } = await supabase
      .from('pedidos')
      .select('total, pagado_en, fecha_pedido, estado_pago')
      .eq('estado_pago', 'pagado')
      .gte('fecha_pedido', mes0);

    let ventasHoy = 0, txHoy = 0, ventasSemana = 0, ventasMes = 0;
    (pagados || []).forEach(p => {
      const f = p.pagado_en || p.fecha_pedido;
      const t = Number(p.total) || 0;
      ventasMes += t;
      if (f >= semana0) ventasSemana += t;
      if (f >= hoy0) { ventasHoy += t; txHoy++; }
    });

    // Pedidos pendientes (no entregados ni cancelados)
    const { count: pendientes } = await supabase
      .from('pedidos').select('id', { count: 'exact', head: true })
      .in('estado', ['pendiente', 'en_preparacion', 'listo']);

    // Totales
    const { count: totalProductos } = await supabase
      .from('productos').select('id', { count: 'exact', head: true }).eq('activo', true);
    const { count: totalClientes } = await supabase
      .from('clientes').select('id', { count: 'exact', head: true });
    const { count: totalIngredientes } = await supabase
      .from('ingredientes').select('id', { count: 'exact', head: true }).eq('activo', true);

    // Caja abierta?
    const { data: caja } = await supabase
      .from('cajas').select('id, estado, responsable, total_ventas, monto_apertura')
      .eq('estado', 'abierta').order('abierta_en', { ascending: false }).maybeSingle();

    // Stock bajo (productos activos con stock <= 5)
    const { data: stockBajo } = await supabase
      .from('productos').select('nombre, stock').eq('activo', true).lte('stock', 5).order('stock');

    return ok({
      success: true,
      ventasHoy, txHoy, ventasSemana, ventasMes,
      pedidosPendientes: pendientes || 0,
      totalProductos: totalProductos || 0,
      totalClientes: totalClientes || 0,
      totalIngredientes: totalIngredientes || 0,
      caja: caja ? { abierta: true, responsable: caja.responsable, totalVentas: Number(caja.total_ventas), apertura: Number(caja.monto_apertura) } : { abierta: false },
      stockBajo: (stockBajo || []).map(s => ({ nombre: s.nombre, stock: Number(s.stock) }))
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
