// netlify/functions/estrategias.js
// Análisis de ventas y estrategias (paso 7 del proceso Monnoserie)
//   - Productos que MÁS salen  → candidatos a ajuste de precio
//   - Productos de POCA salida  → candidatos a promo
//
// GET ?dias=30&token=...  → { topVendidos, bajaSalida, ... }

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] ||
    (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event)) return bad(401, 'No autorizado');

  try {
    const dias = Math.max(1, Math.min(365, parseInt((event.queryStringParameters || {}).dias, 10) || 30));
    const desde = new Date(Date.now() - dias * 86400000).toISOString();

    // Ventas del período: líneas de pedidos (pos + portal) no anulados
    const { data: lineas } = await supabase
      .from('detalle_pedidos')
      .select('producto_id, nombre, cantidad, subtotal, pedidos!inner(fecha_pedido, estado)')
      .gte('pedidos.fecha_pedido', desde);

    const agg = {}; // producto_id -> { unidades, ingreso, nombre }
    let totalUnidades = 0, totalIngreso = 0;
    for (const l of (lineas || [])) {
      const est = String((l.pedidos && l.pedidos.estado) || '').toLowerCase();
      if (est === 'anulado' || est === 'cancelado' || est === 'rechazado') continue;
      const pid = l.producto_id;
      if (pid == null) continue;
      if (!agg[pid]) agg[pid] = { unidades: 0, ingreso: 0, nombre: l.nombre || '' };
      const u = Number(l.cantidad) || 0;
      const ing = Number(l.subtotal) || 0;
      agg[pid].unidades += u;
      agg[pid].ingreso += ing;
      totalUnidades += u; totalIngreso += ing;
    }

    // Catálogo activo (para precio/costo/margen y para detectar los que NO vendieron)
    const { data: prods } = await supabase
      .from('productos')
      .select('id, nombre, sku, precio_minorista, costo_unitario, stock, activo')
      .eq('activo', true);

    const filas = (prods || []).map(p => {
      const a = agg[p.id] || { unidades: 0, ingreso: 0 };
      const precio = Number(p.precio_minorista) || 0;
      const costo = Number(p.costo_unitario) || 0;
      const margen = precio - costo;
      return {
        id: p.id, nombre: p.nombre, sku: p.sku,
        unidades: r2(a.unidades), ingreso: r2(a.ingreso),
        precio, costo, margen: r2(margen),
        margenPct: precio > 0 ? r2((margen / precio) * 100) : null,
        stock: Number(p.stock) || 0
      };
    });

    const conVenta = filas.filter(f => f.unidades > 0).sort((a, b) => b.unidades - a.unidades);
    const sinVenta = filas.filter(f => f.unidades === 0);

    const topVendidos = conVenta.slice(0, 10);

    // Baja salida: los que no vendieron + el cuartil inferior de los que vendieron poco
    const ordenAsc = [...conVenta].sort((a, b) => a.unidades - b.unidades);
    const cuartil = ordenAsc.slice(0, Math.ceil(ordenAsc.length / 4));
    const bajaSalida = [...sinVenta, ...cuartil]
      .sort((a, b) => a.unidades - b.unidades)
      .slice(0, 12);

    return ok({
      success: true, dias, desde,
      totalUnidades: r2(totalUnidades), totalIngreso: r2(totalIngreso),
      productosConVenta: conVenta.length, productosSinVenta: sinVenta.length,
      topVendidos, bajaSalida
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
