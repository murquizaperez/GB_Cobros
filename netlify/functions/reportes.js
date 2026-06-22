// netlify/functions/reportes.js
// GET /api/reportes?dias=30&token=...
// Devuelve: ventas por día, total del período, ventas por canal,
// transacciones, ticket promedio, regalos, anuladas, desglose por medio de pago,
// productos más vendidos, márgenes por producto y valor de inventario.

const { supabase, ok, bad, preflight } = require('./_supabase');
const { valorStock } = require('./_unidades');

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
      .select('total, canal, medio_pago, pagado_en, fecha_pedido, detalle_pedidos(nombre, cantidad, subtotal)')
      .eq('estado_pago', 'pagado')
      .gte('fecha_pedido', desde);

    let totalPeriodo = 0;
    const porDia = {};        // fecha -> total
    const porCanal = { minorista: 0, mayorista: 0, pos: 0 };
    const prodVendidos = {};  // nombre -> {cantidad, total}
    const medioPago = {};     // medio -> {total, transacciones}

    (pedidos || []).forEach(p => {
      const t = Number(p.total) || 0;
      totalPeriodo += t;
      const f = (p.pagado_en || p.fecha_pedido || '').slice(0, 10);
      porDia[f] = (porDia[f] || 0) + t;
      if (porCanal[p.canal] !== undefined) porCanal[p.canal] += t;
      const m = p.medio_pago || 'Sin especificar';
      if (!medioPago[m]) medioPago[m] = { total: 0, transacciones: 0 };
      medioPago[m].total += t;
      medioPago[m].transacciones += 1;
      (p.detalle_pedidos || []).forEach(d => {
        const n = d.nombre || '—';
        if (!prodVendidos[n]) prodVendidos[n] = { cantidad: 0, total: 0 };
        prodVendidos[n].cantidad += Number(d.cantidad) || 0;
        prodVendidos[n].total += Number(d.subtotal) || 0;
      });
    });

    // KPIs de la captura de gastro
    const transacciones = (pedidos || []).length;
    const ticketPromedio = transacciones ? Math.round(totalPeriodo / transacciones) : 0;
    const porMedioPago = Object.entries(medioPago)
      .map(([medio, v]) => ({ medio, total: Math.round(v.total), transacciones: v.transacciones }))
      .sort((a, b) => b.total - a.total);

    // Anuladas (pedidos cancelados del período)
    const { data: anul } = await supabase
      .from('pedidos').select('total').eq('estado', 'cancelado').gte('fecha_pedido', desde);
    const anuladas = (anul || []).length;
    const montoAnulado = Math.round((anul || []).reduce((s, p) => s + (Number(p.total) || 0), 0));

    // Regalos (requiere columna es_regalo; si no existe, queda en null sin romper)
    let regalos = null;
    try {
      const rg = await supabase
        .from('pedidos').select('id', { count: 'exact', head: true })
        .eq('es_regalo', true).gte('fecha_pedido', desde);
      if (!rg.error) regalos = rg.count || 0;
    } catch (e) { /* columna aún no creada */ }

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

    // Consumo de ingredientes (ventas × recetas del período)
    const cantPorProducto = {};
    (pedidos || []).forEach(p => {
      (p.detalle_pedidos || []).forEach(d => {
        const n = d.nombre || '';
        cantPorProducto[n] = (cantPorProducto[n] || 0) + (Number(d.cantidad) || 0);
      });
    });
    const { data: recetasAll } = await supabase
      .from('recetas')
      .select('cantidad, productos(nombre), ingredientes(nombre, unidad)');
    const consumo = {}; // ingrediente -> {cantidad, unidad}
    (recetasAll || []).forEach(r => {
      const prodNom = r.productos ? r.productos.nombre : '';
      const vendidas = cantPorProducto[prodNom] || 0;
      if (!vendidas) return;
      const ing = r.ingredientes ? r.ingredientes.nombre : '';
      const uni = r.ingredientes ? r.ingredientes.unidad : '';
      if (!consumo[ing]) consumo[ing] = { cantidad: 0, unidad: uni };
      consumo[ing].cantidad += Number(r.cantidad) * vendidas;
    });
    const consumoIngredientes = Object.entries(consumo)
      .map(([nombre, v]) => ({ nombre, cantidad: Math.round(v.cantidad * 100) / 100, unidad: v.unidad }))
      .sort((a, b) => b.cantidad - a.cantidad).slice(0, 15);

    // Valor de inventario
    let valProductos = 0;
    (productos || []).forEach(p => { valProductos += (Number(p.stock) || 0) * (Number(p.costo_unitario) || 0); });
    // Insumos: stock está en base g/ml y costo por Kg/L → usar valorStock (aplica ÷1000 si corresponde)
    const { data: ingredientes } = await supabase.from('ingredientes').select('stock_actual, costo_unitario, unidad');
    let valIngredientes = 0;
    (ingredientes || []).forEach(i => { valIngredientes += valorStock(i.stock_actual, i.costo_unitario, i.unidad); });

    return ok({
      success: true, dias,
      totalPeriodo: Math.round(totalPeriodo),
      transacciones, ticketPromedio, regalos,
      anuladas, montoAnulado,
      porMedioPago,
      ventasPorDia, porCanal, topProductos, margenes,
      consumoIngredientes,
      valorInventario: { productos: Math.round(valProductos), ingredientes: Math.round(valIngredientes), total: Math.round(valProductos + valIngredientes) }
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
