// netlify/functions/reportes.js
// GET /api/reportes?dias=30&token=...
// Devuelve: ventas por día, total del período, ventas por canal,
// productos más vendidos, márgenes por producto y valor de inventario.

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

  const dias = Math.min(parseInt((event.queryStringParameters || {}).dias || '30', 10) || 30, 365);

  try {
    const desde = new Date(Date.now() - dias * 864e5).toISOString();

    // Pedidos pagados del período con detalle
    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('total, canal, pagado_en, fecha_pedido, detalle_pedidos(nombre, cantidad, subtotal)')
      .eq('estado_pago', 'pagado')
      .gte('fecha_pedido', desde);

    let totalPeriodo = 0;
    const porDia = {};        // fecha -> total
    const porCanal = { minorista: 0, mayorista: 0, pos: 0 };
    const prodVendidos = {};  // nombre -> {cantidad, total}

    (pedidos || []).forEach(p => {
      const t = Number(p.total) || 0;
      totalPeriodo += t;
      const f = (p.pagado_en || p.fecha_pedido || '').slice(0, 10);
      porDia[f] = (porDia[f] || 0) + t;
      if (porCanal[p.canal] !== undefined) porCanal[p.canal] += t;
      (p.detalle_pedidos || []).forEach(d => {
        const n = d.nombre || '—';
        if (!prodVendidos[n]) prodVendidos[n] = { cantidad: 0, total: 0 };
        prodVendidos[n].cantidad += Number(d.cantidad) || 0;
        prodVendidos[n].total += Number(d.subtotal) || 0;
      });
    });

    // Serie de ventas por día (ordenada, rellenando días sin ventas)
    const ventasPorDia = [];
    for (let i = dias - 1; i >= 0; i--) {
      const f = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      ventasPorDia.push({ fecha: f, total: Math.round((porDia[f] || 0)) });
    }

    // Top productos
    const topProductos = Object.entries(prodVendidos)
      .map(([nombre, v]) => ({ nombre, cantidad: v.cantidad, total: Math.round(v.total) }))
      .sort((a, b) => b.cantidad - a.cantidad).slice(0, 12);

    // Márgenes (productos activos con costo cargado)
    const { data: productos } = await supabase
      .from('productos').select('nombre, precio_minorista, costo_unitario, stock').eq('activo', true);
    const margenes = (productos || [])
      .filter(p => Number(p.precio_minorista) > 0)
      .map(p => {
        const precio = Number(p.precio_minorista), costo = Number(p.costo_unitario) || 0;
        const margen = precio - costo;
        return { nombre: p.nombre, precio, costo, margen, margenPct: precio ? Math.round(margen / precio * 100) : 0 };
      })
      .sort((a, b) => b.margenPct - a.margenPct);

    // Valor de inventario
    let valProductos = 0;
    (productos || []).forEach(p => { valProductos += (Number(p.stock) || 0) * (Number(p.costo_unitario) || 0); });
    const { data: ingredientes } = await supabase.from('ingredientes').select('stock_actual, costo_unitario');
    let valIngredientes = 0;
    (ingredientes || []).forEach(i => { valIngredientes += (Number(i.stock_actual) || 0) * (Number(i.costo_unitario) || 0); });

    return ok({
      success: true, dias,
      totalPeriodo: Math.round(totalPeriodo),
      ventasPorDia, porCanal, topProductos, margenes,
      valorInventario: { productos: Math.round(valProductos), ingredientes: Math.round(valIngredientes), total: Math.round(valProductos + valIngredientes) }
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
