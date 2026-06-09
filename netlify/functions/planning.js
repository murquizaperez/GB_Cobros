// netlify/functions/planning.js
// GET /api/planning?token=...
// Devuelve la demanda esperada de cada producto para cada día de la semana
// (promedio histórico), como matriz producto × día, para armar el tablero semanal.

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
    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('pagado_en, fecha_pedido, detalle_pedidos(nombre, cantidad)')
      .eq('estado_pago', 'pagado');

    // acumulado[dia][producto] = total ; fechas[dia] = set de fechas distintas
    const acum = {}, fechas = {};
    (pedidos || []).forEach(p => {
      const f = p.pagado_en || p.fecha_pedido;
      if (!f) return;
      const dia = new Date(f).getUTCDay();
      if (!fechas[dia]) fechas[dia] = new Set();
      fechas[dia].add(f.slice(0, 10));
      if (!acum[dia]) acum[dia] = {};
      (p.detalle_pedidos || []).forEach(d => {
        const n = d.nombre || '';
        acum[dia][n] = (acum[dia][n] || 0) + (Number(d.cantidad) || 0);
      });
    });

    // Productos activos
    const { data: productos } = await supabase
      .from('productos').select('id, nombre, stock').eq('activo', true).order('nombre');

    // Matriz: por cada producto, demanda promedio por día
    const filas = (productos || []).map(p => {
      const porDia = [];
      let totalSemana = 0;
      for (let dia = 0; dia < 7; dia++) {
        const ocur = fechas[dia] ? fechas[dia].size : 0;
        const dem = ocur ? Math.round((acum[dia] && acum[dia][p.nombre] || 0) / ocur) : 0;
        porDia.push(dem);
        totalSemana += dem;
      }
      return { productoId: p.id, nombre: p.nombre, stock: Number(p.stock) || 0, porDia, totalSemana };
    }).filter(f => f.totalSemana > 0);

    // Muestras por día (para mostrar confianza)
    const muestras = [];
    for (let dia = 0; dia < 7; dia++) muestras.push(fechas[dia] ? fechas[dia].size : 0);

    return ok({ success: true, filas, muestras });
  } catch (err) {
    return bad(500, String(err));
  }
};
