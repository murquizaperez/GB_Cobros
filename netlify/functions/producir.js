// netlify/functions/producir.js
// Producción de lotes con merma a nivel PRODUCTO e INGREDIENTE (flujo de dos pasos)
// + compatibilidad legacy (un paso).
//
// POST { accion:'iniciar', productoId, cantidadEsperada, empleado?, forzar?, token }
//    → crea lote EN PROCESO, descuenta materia prima teórica (receta × esperada),
//      guarda costo teórico y el detalle por ingrediente. No suma stock del producto.
//
// POST { accion:'finalizar', loteId, cantidadReal, consumosReales?, notas?, token }
//    → cierra el lote: cantidad real producida + (opcional) uso REAL por ingrediente.
//      Con consumosReales: ajusta stock por la diferencia teórico−real de cada ingrediente,
//      calcula el desvío por ingrediente y RECALCULA el costo del lote sobre el uso real.
//
// POST { productoId, cantidad, ... }  (LEGACY, un paso) → produce y finaliza en el acto.
//
// GET ?token=...            → historial (en proceso + finalizados)
// GET ?loteId=N&token=...   → detalle teórico por ingrediente (para el form de finalización)

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (body && body.token) ||
    (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}

function minutosEntre(ini, fin) {
  if (!ini || !fin) return null;
  return Math.max(0, Math.round((new Date(fin) - new Date(ini)) / 60000));
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// --- Conversión de unidades para COSTO ---------------------------------------
// El costo_unitario del ingrediente está cargado por Kg / L, pero las recetas
// se cargan en g / ml. Si multiplicáramos cantidad(g) × costo(/Kg) el costo sale
// ×1000. factorCosto convierte la cantidad de receta a la unidad del ingrediente.
// Supuesto (válido para todas las recetas actuales de Monnoserie): cuando el
// insumo está en Kg/L, la receta está en g/ml. Si alguna receta usara Kg/L
// directo para un insumo en Kg/L, este factor NO debe dividir → ver nota abajo.
function factorCosto(unidadIng) {
  const ui = String(unidadIng || '').toLowerCase().trim();
  return (ui === 'kg' || ui === 'l') ? 0.001 : 1;
}
// Unidad a mostrar/guardar en la línea de receta: si el insumo está en Kg/L,
// la línea se expresa en g/ml (que es como está la cantidad).
function unidadLinea(unidadReceta, unidadIng) {
  const ui = String(unidadIng || '').toLowerCase().trim();
  if (ui === 'kg') return 'g';
  if (ui === 'l')  return 'ml';
  return unidadReceta || ui || '';
}

// Lee la receta y calcula requerimiento + costo + faltantes para una cantidad dada
async function calcularLote(productoId, cantidad) {
  const { data: receta } = await supabase
    .from('recetas')
    .select('ingrediente_id, cantidad, unidad, ingredientes(nombre, unidad, stock_actual, costo_unitario)')
    .eq('producto_id', productoId);

  let costoTotal = 0;
  const faltantes = [];
  const descuentos = [];
  const consumos = [];

  (receta || []).forEach(r => {
    const necesita = Number(r.cantidad) * cantidad;          // en unidad de receta (g/ml/unid)
    const ing = r.ingredientes || {};
    const disp = Number(ing.stock_actual) || 0;
    const factor = factorCosto(ing.unidad);                  // g/ml -> Kg/L para costear
    const costoLinea = necesita * (Number(ing.costo_unitario) || 0) * factor;
    costoTotal += costoLinea;
    if (disp < necesita) faltantes.push({ nombre: ing.nombre, necesita, disponible: disp });
    descuentos.push({ id: r.ingrediente_id, nuevo: Math.max(0, disp - necesita), cant: necesita });
    consumos.push({
      ingrediente_id: r.ingrediente_id, nombre: ing.nombre || '',
      cantidad: necesita, unidad: unidadLinea(r.unidad, ing.unidad), costo_linea: r2(costoLinea)
    });
  });

  return { tieneReceta: (receta || []).length > 0, costoTotal, faltantes, descuentos, consumos };
}

async function codigoTraza() {
  const hoy = new Date();
  const ymd = hoy.toISOString().slice(0, 10).replace(/-/g, '');
  const { count } = await supabase.from('lotes_produccion')
    .select('id', { count: 'exact', head: true })
    .gte('fecha', hoy.toISOString().slice(0, 10));
  const corr = String((count || 0) + 1).padStart(4, '0');
  return `L-${ymd}-${corr}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  // ---------- GET ----------
  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    const qs = event.queryStringParameters || {};

    // GET detalle teórico de un lote (para armar el form de finalización)
    if (qs.loteId) {
      try {
        const { data: det } = await supabase
          .from('lote_ingredientes')
          .select('id, ingrediente_id, nombre, cantidad, unidad, costo_linea, cantidad_real, desvio, costo_real, ingredientes(costo_unitario)')
          .eq('lote_id', parseInt(qs.loteId, 10));
        const detalle = (det || []).map(d => ({
          ingredienteId: d.ingrediente_id, nombre: d.nombre,
          teorico: Number(d.cantidad) || 0, unidad: d.unidad || '',
          costoUnitario: Number(d.ingredientes && d.ingredientes.costo_unitario) || 0,
          cantidadReal: d.cantidad_real == null ? null : Number(d.cantidad_real),
          desvio: d.desvio == null ? null : Number(d.desvio),
          costoTeorico: Number(d.costo_linea) || 0,
          costoReal: d.costo_real == null ? null : Number(d.costo_real)
        }));
        return ok({ success: true, detalle });
      } catch (err) { return bad(500, String(err)); }
    }

    // GET historial
    try {
      const { data } = await supabase
        .from('lotes_produccion')
        .select('id, codigo_trazabilidad, cantidad_producida, cantidad_esperada, costo_total, costo_teorico, ingredientes_ok, estado, empleado, responsable, notas, fecha, hora_inicio, hora_fin, productos(nombre)')
        .order('fecha', { ascending: false }).limit(60);
      const lotes = (data || []).map(l => {
        const estado = l.estado || 'finalizado';
        const esperada = l.cantidad_esperada == null ? null : Number(l.cantidad_esperada);
        const real = Number(l.cantidad_producida) || 0;
        return {
          id: l.id, codigo: l.codigo_trazabilidad,
          producto: l.productos ? l.productos.nombre : '',
          estado,
          cantidad: real, cantidadReal: real, cantidadEsperada: esperada,
          diferencia: (estado === 'finalizado' && esperada != null) ? real - esperada : null,
          costo: Number(l.costo_total) || 0,
          costoTeorico: l.costo_teorico == null ? null : Number(l.costo_teorico),
          ingredientesOk: l.ingredientes_ok,
          empleado: l.empleado || l.responsable || '',
          responsable: l.responsable || l.empleado || '',
          notas: l.notas, fecha: l.fecha,
          horaInicio: l.hora_inicio, horaFin: l.hora_fin,
          tiempoMin: minutosEntre(l.hora_inicio, l.hora_fin || (estado === 'finalizado' ? l.fecha : null))
        };
      });
      return ok({
        success: true, lotes,
        enProceso: lotes.filter(l => l.estado === 'en_proceso'),
        finalizados: lotes.filter(l => l.estado !== 'en_proceso')
      });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const accion = String(body.accion || '').trim();

  // ---------- FINALIZAR TANDA ----------
  if (accion === 'finalizar') {
    const loteId = parseInt(body.loteId, 10);
    const real = Number(body.cantidadReal);
    if (!loteId) return bad(400, 'Falta loteId');
    if (!(real >= 0)) return bad(400, 'Cantidad real inválida');
    try {
      const { data: lote } = await supabase
        .from('lotes_produccion')
        .select('id, producto_id, cantidad_esperada, estado, hora_inicio, costo_total')
        .eq('id', loteId).maybeSingle();
      if (!lote) return bad(404, 'Lote no encontrado');
      if (lote.estado === 'finalizado') return bad(400, 'El lote ya está finalizado');

      // Sumar el stock REAL producido (alta atómica; devuelve el nuevo stock)
      const { data: nuevoStock } = await supabase.rpc('ajustar_stock_producto', { p_id: lote.producto_id, p_delta: real });

      const horaFin = new Date().toISOString();
      const upd = { cantidad_producida: real, estado: 'finalizado', hora_fin: horaFin };
      if (typeof body.notas === 'string' && body.notas.trim() !== '') upd.notas = body.notas.trim();

      // ----- USO REAL POR INGREDIENTE (check receta vs práctica real) -----
      const reales = Array.isArray(body.consumosReales) ? body.consumosReales : null;
      let costoReal = null, detalleMerma = [];
      if (reales && reales.length) {
        const { data: li } = await supabase
          .from('lote_ingredientes')
          .select('id, ingrediente_id, nombre, cantidad, ingredientes(unidad, stock_actual, costo_unitario)')
          .eq('lote_id', loteId);
        costoReal = 0;
        const tareas = [];
        for (const item of (li || [])) {
          const teo = Number(item.cantidad) || 0;
          const match = reales.find(x => Number(x.ingredienteId || x.ingrediente_id) === Number(item.ingrediente_id));
          const usado = match && match.cantidadReal != null ? Number(match.cantidadReal) : teo;
          const cu = Number(item.ingredientes && item.ingredientes.costo_unitario) || 0;
          const factor = factorCosto(item.ingredientes && item.ingredientes.unidad); // g/ml -> Kg/L
          const costoLineaReal = usado * cu * factor;
          costoReal += costoLineaReal;
          // Ajuste de stock: al iniciar se descontó el teórico. Devolvemos (teo - usado):
          // usó menos → vuelve al stock; usó más → descuenta el extra.
          const ajuste = teo - usado;
          if (ajuste !== 0) {
            // Ajuste atómico: usó menos → suma (delta+); usó más → resta (delta−).
            tareas.push(supabase.rpc('ajustar_stock_ingrediente', { p_id: item.ingrediente_id, p_delta: ajuste }));
          }
          tareas.push(supabase.from('lote_ingredientes').update({
            cantidad_real: usado, desvio: r2(usado - teo), costo_real: r2(costoLineaReal)
          }).eq('id', item.id));
          detalleMerma.push({ nombre: item.nombre, teorico: teo, real: usado, desvio: r2(usado - teo) });
        }
        await Promise.all(tareas);   // optimización: escrituras por ingrediente en paralelo
        upd.costo_total = r2(costoReal); // contabilización de costos en función de la merma real
      }

      await supabase.from('lotes_produccion').update(upd).eq('id', loteId);

      const esperada = Number(lote.cantidad_esperada) || 0;
      return ok({
        success: true, loteId, cantidadReal: real, nuevoStock,
        diferencia: real - esperada,
        tiempoMin: minutosEntre(lote.hora_inicio, horaFin),
        costoTeorico: Number(lote.costo_total) || 0,
        costoReal: costoReal == null ? null : r2(costoReal),
        detalleMerma
      });
    } catch (err) { return bad(500, String(err)); }
  }

  // ---------- INICIAR o LEGACY ----------
  const productoId = parseInt(body.productoId, 10);
  if (!productoId) return bad(400, 'Falta productoId');
  const esIniciar = accion === 'iniciar';
  const cantidad = Number(esIniciar ? body.cantidadEsperada : body.cantidad);
  if (!cantidad || cantidad <= 0) return bad(400, 'Cantidad inválida');

  try {
    const { data: prod } = await supabase.from('productos').select('id, nombre, stock').eq('id', productoId).maybeSingle();
    if (!prod) return bad(404, 'Producto no encontrado');

    const { tieneReceta, costoTotal, faltantes, descuentos, consumos } = await calcularLote(productoId, cantidad);

    if (faltantes.length && !body.forzar) {
      return ok({ success: false, faltantes, mensaje: 'No alcanza la materia prima para este lote' });
    }

    // Descontar materia prima en paralelo y generar el código a la vez (optimización: 1 ida vs N)
    const ahora = new Date().toISOString();
    const [codigo] = await Promise.all([
      codigoTraza(),
      ...descuentos.map(d =>
        // Descuento atómico del insumo (delta negativo = consumo).
        supabase.rpc('ajustar_stock_ingrediente', { p_id: d.id, p_delta: -(Number(d.cant) || 0) })
      )
    ]);
    const empleado = String(body.empleado || body.responsable || '');

    if (esIniciar) {
      const { data: lote } = await supabase.from('lotes_produccion').insert({
        producto_id: productoId, cantidad_esperada: cantidad, cantidad_producida: 0,
        costo_total: costoTotal, costo_teorico: costoTotal, ingredientes_ok: tieneReceta,
        codigo_trazabilidad: codigo, empleado, responsable: empleado, estado: 'en_proceso',
        hora_inicio: ahora, notas: String(body.notas || '')
      }).select('id').maybeSingle();

      if (lote && lote.id && consumos.length) {
        await supabase.from('lote_ingredientes').insert(consumos.map(c => ({ ...c, lote_id: lote.id })));
      }
      return ok({
        success: true, loteId: lote && lote.id, codigoTrazabilidad: codigo, producto: prod.nombre,
        cantidadEsperada: cantidad, costoEstimado: costoTotal, estado: 'en_proceso', sinReceta: !tieneReceta
      });
    }

    // LEGACY: un solo paso (alta atómica; devuelve el nuevo stock)
    const { data: nuevoStock } = await supabase.rpc('ajustar_stock_producto', { p_id: productoId, p_delta: cantidad });

    const { data: lote } = await supabase.from('lotes_produccion').insert({
      producto_id: productoId, cantidad_esperada: cantidad, cantidad_producida: cantidad,
      costo_total: costoTotal, costo_teorico: costoTotal, ingredientes_ok: tieneReceta,
      codigo_trazabilidad: codigo, empleado, responsable: empleado, estado: 'finalizado',
      hora_inicio: ahora, hora_fin: ahora, notas: String(body.notas || '')
    }).select('id').maybeSingle();

    if (lote && lote.id && consumos.length) {
      await supabase.from('lote_ingredientes').insert(consumos.map(c => ({ ...c, lote_id: lote.id })));
    }

    return ok({
      success: true, loteId: lote && lote.id, codigoTrazabilidad: codigo, producto: prod.nombre,
      cantidad, nuevoStock, costoLote: costoTotal,
      ingredientesDescontados: descuentos.length, sinReceta: !tieneReceta
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
