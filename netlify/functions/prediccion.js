// netlify/functions/prediccion.js
// GET /api/prediccion?dia=5&token=...
//   dia = día de la semana objetivo (0=domingo … 6=sábado). OPCIONAL:
//         si no se manda (o es inválido), usa el día de HOY (hora Argentina).
//   Calcula la demanda esperada de cada producto para ese día (promedio histórico
//   de ventas en ese mismo día de la semana), le resta el stock actual y sugiere
//   cuánto producir. Descuenta la MERMA promedio de ese día (lo que sistemáticamente
//   se tira) para no recomendar sobreproducir. Además chequea si hay materia prima.

const { supabase, ok, bad, preflight } = require('./_supabase');

const VENTANA_MERMA_DIAS = 56;   // ~8 semanas de merma para el promedio
const FACTOR_MERMA = 0.7;        // recorte conservador (no descontar el 100%)

// Día de la semana en hora Argentina (UTC-3). Sirve tanto para timestamps
// (pagado_en) como para fechas puras 'YYYY-MM-DD' (mermas.fecha), sin corrimientos.
function diaAR(v) {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T12:00:00-03:00').getUTCDay();
  return new Date(new Date(v).getTime() - 3 * 3600 * 1000).getUTCDay();
}

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

  // dia opcional → si falta o es inválido, usamos hoy (hora Argentina)
  let diaObjetivo = parseInt((event.queryStringParameters || {}).dia, 10);
  if (isNaN(diaObjetivo) || diaObjetivo < 0 || diaObjetivo > 6) diaObjetivo = diaAR(Date.now());

  try {
    // 1) Historial de ventas pagadas con detalle
    const { data: pedidosHist } = await supabase
      .from('pedidos')
      .select('pagado_en, fecha_pedido, estado_pago, detalle_pedidos(nombre, cantidad)')
      .eq('estado_pago', 'pagado');

    const ventasPorDiaProd = {};   // dia -> {producto -> cantidad}
    const fechasPorDia = {};       // dia -> Set(fechas)
    (pedidosHist || []).forEach(p => {
      const f = p.pagado_en || p.fecha_pedido;
      if (!f) return;
      const dia = diaAR(f);
      if (!fechasPorDia[dia]) fechasPorDia[dia] = new Set();
      fechasPorDia[dia].add(String(f).slice(0, 10));
      if (!ventasPorDiaProd[dia]) ventasPorDiaProd[dia] = {};
      (p.detalle_pedidos || []).forEach(det => {
        const n = det.nombre || '';
        ventasPorDiaProd[dia][n] = (ventasPorDiaProd[dia][n] || 0) + (Number(det.cantidad) || 0);
      });
    });

    const ocurrencias = fechasPorDia[diaObjetivo] ? fechasPorDia[diaObjetivo].size : 0;
    const ventasDia = ventasPorDiaProd[diaObjetivo] || {};

    // 1b) Merma reciente por día de semana (si la tabla existe; si no, no ajusta)
    const mermaPorDiaProd = {};    // dia -> {producto -> unidades}
    const fechasMermaPorDia = {};  // dia -> Set(fechas)
    try {
      const desdeMerma = new Date(Date.now() - VENTANA_MERMA_DIAS * 864e5).toISOString().slice(0, 10);
      const { data: mermas, error: errM } = await supabase
        .from('mermas').select('nombre, cantidad, fecha').gte('fecha', desdeMerma);
      if (!errM) {
        (mermas || []).forEach(m => {
          if (!m.fecha) return;
          const dia = diaAR(m.fecha);
          if (!fechasMermaPorDia[dia]) fechasMermaPorDia[dia] = new Set();
          fechasMermaPorDia[dia].add(String(m.fecha).slice(0, 10));
          if (!mermaPorDiaProd[dia]) mermaPorDiaProd[dia] = {};
          const n = m.nombre || '';
          mermaPorDiaProd[dia][n] = (mermaPorDiaProd[dia][n] || 0) + (Number(m.cantidad) || 0);
        });
      }
    } catch (e) { /* tabla mermas aún no creada: seguimos sin ajuste */ }

    const ocurrMerma = fechasMermaPorDia[diaObjetivo] ? fechasMermaPorDia[diaObjetivo].size : 0;
    const mermaDia = mermaPorDiaProd[diaObjetivo] || {};

    // 2) Productos activos con stock
    const { data: productos } = await supabase
      .from('productos').select('id, nombre, stock, activo, precio_minorista, costo_unitario').eq('activo', true);

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
      const pedidosConfirmados = pedidosPend[p.nombre] || 0;
      const stock = Number(p.stock) || 0;

      // Ajuste por merma promedio de ese día de semana (solo con señal suficiente)
      const mermaProm = (ocurrMerma >= 2) ? (mermaDia[p.nombre] || 0) / ocurrMerma : 0;
      const ajusteMerma = Math.round(mermaProm * FACTOR_MERMA);

      const sugeridoSinMerma = Math.max(0, demanda + pedidosConfirmados - stock);
      const sugerido = Math.max(0, sugeridoSinMerma - ajusteMerma);

      // ¿alcanza la materia prima? Stock de insumos en la misma escala que la receta (g/ml).
      let materiaOk = true; const faltan = [];
      (recetaPorProd[p.id] || []).forEach(r => {
        const ing = r.ingredientes || {};
        const necesita = Number(r.cantidad) * sugerido;
        if (sugerido > 0 && necesita > Number(ing.stock_actual || 0)) {
          materiaOk = false; faltan.push(ing.nombre);
        }
      });

      const precio = Number(p.precio_minorista) || 0;
      const costo = Number(p.costo_unitario) || 0;
      const margenUnit = precio - costo;
      return {
        productoId: p.id, nombre: p.nombre,
        demanda, pedidos: pedidosConfirmados, stock,
        mermaProm: Math.round(mermaProm * 10) / 10, ajusteMerma,
        sugeridoSinMerma, sugerido,
        precio, costo, margenUnit,
        gananciaPotencial: Math.round(margenUnit * sugerido),
        tieneReceta: !!(recetaPorProd[p.id] && recetaPorProd[p.id].length),
        materiaOk, faltan
      };
    })
    .filter(s => s.demanda > 0 || s.pedidos > 0 || s.sugerido > 0 || s.ajusteMerma > 0)
    .sort((a, b) => b.sugerido - a.sugerido);

    return ok({
      success: true,
      dia: diaObjetivo,
      muestras: ocurrencias,
      muestrasMerma: ocurrMerma,
      ventanaMermaDias: VENTANA_MERMA_DIAS,
      factorMerma: FACTOR_MERMA,
      sugerencias
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
