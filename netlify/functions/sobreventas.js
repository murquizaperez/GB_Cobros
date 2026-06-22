// netlify/functions/sobreventas.js
// GET /api/sobreventas?dias=30&token=...
// Lista las sobreventas del período (ventas que descontaron más stock del que había).
// Señal de error de conteo o stock fantasma. Solo lectura.

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
  const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);

  try {
    const { data: regs, error } = await supabase
      .from('sobreventas')
      .select('id, producto_id, nombre, vendidas, stock_previo, faltante, pedido_id, fecha, creado_en')
      .gte('fecha', desde)
      .order('creado_en', { ascending: false });
    // Si la tabla no existe todavía, devolvemos vacío sin romper
    if (error) return ok({ success: true, dias, total: 0, porProducto: [], registros: [], pendienteMigracion: true });

    const porProd = {};
    let totalFaltante = 0;
    (regs || []).forEach(r => {
      const f = Number(r.faltante) || 0;
      totalFaltante += f;
      const n = r.nombre || '—';
      if (!porProd[n]) porProd[n] = { nombre: n, eventos: 0, faltante: 0 };
      porProd[n].eventos += 1;
      porProd[n].faltante += f;
    });

    return ok({
      success: true, dias,
      total: (regs || []).length,
      totalFaltante,
      porProducto: Object.values(porProd).sort((a, b) => b.faltante - a.faltante),
      registros: (regs || []).slice(0, 100)
    });
  } catch (err) { return bad(500, String(err)); }
};
