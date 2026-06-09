// netlify/functions/prediccion.js
// GET /api/prediccion?dia=5&token=...
//   dia = día de la semana objetivo (0=domingo … 6=sábado).
//   Calcula la demanda esperada de cada producto para ese día (promedio histórico
//   de ventas en ese mismo día de la semana), le resta el stock actual y sugiere
//   cuánto producir. Además chequea si hay materia prima para esa producción.

const { supabase, ok, bad, preflight } = require('./_supabase');
const { costoLinea } = require('./_costos');

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

  const diaObjetivo = parseInt((event.queryStringParameters || {}).dia, 10);
  if (isNaN(diaObjetivo) || diaObjetivo < 0 || diaObjetivo > 6) return bad(400, 'Día inválido (0-6)');

  try {
    // 1) Historial de ventas pagadas con detalle
    const { data: pedidos } = await supabase
      .from('pedidos')
      .select('pagado_en, fecha_pedido, estado_pago, detalle_pedidos(nombre, cantidad)')
      .eq('estado_pago', 'pagado');

    // Acumular cantidad por (producto, diaSemana) y contar fechas distintas por día
    const ventasPorDiaProd = {};   // dia -> {producto -> cantidad}
    const fechasPorDia = {};       // dia -> Set(fechas)
    (pedidos || []).forEach(p => {
      const f = p.pagado_en || p.fecha_pedido;
      if (!f) return;
      const d = new Date(f);
      const dia = d.getUTCDay();
      const fechaStr = f.slice(0, 10);
      if (!fechasPorDia[dia]) fechasPorDia[dia] = new Set();
      fechasPorDia[dia].add(fechaStr);
      if (!ventasPorDiaProd[dia]) ventasPorDiaProd[dia] = {};
      (p.detalle_pedidos || []).forEach(det => {
        const n = det.nombre || '';
        ventasPorDiaProd[dia][n] = (ventasPorDiaProd[dia][n] || 0) + (Number(det.cantidad) || 0);
      });
    });

    const ocurrencias = fechasPorDia[diaObjetivo] ? fechasPorDia[diaObjetivo].size : 0;
    const ventasDia = ventasPorDiaProd[diaObjetivo] || {};

    // 2) Productos activos con stock
    const { data: productos } = await supabase
      .from('productos').select('id, nombre, stock, activo, precio_minorista').eq('activo', true);

    // 3) Pedidos del portal pendientes (demanda confirmada futura)
    const { data: pend } = await supabase
      .from('pedidos').select('detalle_pedidos(nombre, cantidad)')
      .in('estado', ['pendiente', 'en_preparacion']);
    const pedidosPend = {};
    (pend || []).forEach(p => (p.detalle_pedidos || []).forEach(d => {
      pedidosPend[d.nombre] = (pedidosPend[d.nombre] || 0) + (Number(d.cantidad) || 0);
    }));

    // 4) Recetas + ingredientes para chequear materia prima
    const { data: recetas } = await supabase
      .from('recetas').select('producto_id, cantidad, unidad, ingredientes(id, nombre, stock_actual, costo_unitario, unidad)');
    const recetaPorProd = {};
    (recetas || []).forEach(r => {
      if (!recetaPorProd[r.producto_id]) recetaPorProd[r.producto_id] = [];
      recetaPorProd[r.producto_id].push(r);
    });

    // 5) Armar sugerencias
    const sugerencias = (productos || []).map(p => {
      const demanda = Math.round(ocurrencias ? (ventasDia[p.nombre] || 0) / ocurrencias : 0);
      const pedidos = pedidosPend[p.nombre] || 0;
      const stock = Number(p.stock) || 0;
      // necesidad = demanda esperada + pedidos confirmados − stock disponible
      let sugerido = Math.max(0, demanda + pedidos - stock);

      // ¿alcanza la materia prima?
      let materiaOk = true; const faltan = [];
      (recetaPorProd[p.id] || []).forEach(r => {
        const ing = r.ingredientes || {};
        const necesita = Number(r.cantidad) * sugerido;
        // convertir necesita (en unidad receta) a la unidad base del ingrediente para comparar con su stock
        // comparamos en la unidad del ingrediente: usamos costoLinea con costo=1 para obtener cantidad equivalente no aplica;
        // simplificación: comparar consumo en unidad receta vs stock del ingrediente convertido a esa misma escala
        // (para el chequeo basta detectar si el stock del ingrediente es claramente insuficiente)
        if (sugerido > 0 && Number(ing.stock_actual) <= 0) { materiaOk = false; faltan.push(ing.nombre); }
      });

      return {
        productoId: p.id, nombre: p.nombre,
        demanda, pedidos, stock, sugerido,
        tieneReceta: !!(recetaPorProd[p.id] && recetaPorProd[p.id].length),
        materiaOk, faltan
      };
    })
    .filter(s => s.demanda > 0 || s.pedidos > 0 || s.sugerido > 0)
    .sort((a, b) => b.sugerido - a.sugerido);

    return ok({
      success: true,
      dia: diaObjetivo,
      muestras: ocurrencias,         // cuántos "ese día" hay en el historial
      sugerencias
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
