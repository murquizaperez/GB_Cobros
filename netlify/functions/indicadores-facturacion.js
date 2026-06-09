// netlify/functions/indicadores-facturacion.js
// GET /api/indicadores-facturacion?token=...
// Total de pedidos, cuántos con/sin factura, % facturado y total facturado.

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
    // Total de pedidos
    const { count: totalPedidos } = await supabase
      .from('pedidos').select('id', { count: 'exact', head: true });

    // Pedidos con factura válida (con CAE) y total facturado
    const { data: facturas } = await supabase
      .from('facturas').select('pedido_id, importe, cae');
    const conCae = (facturas || []).filter(f => f.cae);
    const pedidosFacturados = new Set(conCae.map(f => f.pedido_id));
    const totalFacturado = conCae.reduce((s, f) => s + (Number(f.importe) || 0), 0);

    const conFactura = pedidosFacturados.size;
    const total = totalPedidos || 0;
    const sinFactura = Math.max(0, total - conFactura);
    const pct = total ? Math.round((conFactura / total) * 1000) / 10 : 0;

    return ok({
      success: true,
      totalPedidos: total,
      conFactura, sinFactura,
      porcentajeFacturado: pct,
      totalFacturado: Math.round(totalFacturado)
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
