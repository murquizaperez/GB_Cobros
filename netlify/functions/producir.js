// netlify/functions/producir.js
// Producción de lotes con cálculo de mermas (flujo de dos pasos) + compatibilidad legacy.
//
// POST { accion:'iniciar', productoId, cantidadEsperada, empleado?, responsable?, forzar?, token }
//    → crea un lote EN PROCESO, descuenta la materia prima (requerimiento teórico),
//      registra hora de inicio y costo estimado. NO suma stock del producto todavía.
//
// POST { accion:'finalizar', loteId, cantidadReal, token }
//    → cierra el lote: guarda la cantidad real producida, calcula diferencia (merma)
//      y tiempo (fin − inicio), y recién ahí suma el stock real del producto.
//
// POST { productoId, cantidad, responsable?, notas?, forzar?, token }  (LEGACY, un paso)
//    → produce de una (lo usan Predicción y Planning): descuenta materia prima,
//      suma stock y deja el lote FINALIZADO con diferencia 0.
//
// GET ?token=...  → historial de lotes (en proceso + finalizados) con merma y tiempo.

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

// Lee la receta y calcula requerimiento + costo + faltantes para una cantidad dada
async function calcularLote(productoId, cantidad) {
  const { data: receta } = await supabase
    .from('recetas')
    .select('ingrediente_id, cantidad, unidad, ingredientes(nombre, stock_actual, costo_unitario)')
    .eq('producto_id', productoId);

  let costoTotal = 0;
  const faltantes = [];
  const descuentos = [];
  const consumos = [];

  (receta || []).forEach(r => {
    const necesita = Number(r.cantidad) * cantidad;
    const ing = r.ingredientes || {};
    const disp = Number(ing.stock_actual) || 0;
    const costoLinea = necesita * (Number(ing.costo_unitario) || 0);
    costoTotal += costoLinea;
    if (disp < necesita) faltantes.push({ nombre: ing.nombre, necesita, disponible: disp });
    descuentos.push({ id: r.ingrediente_id, nuevo: Math.max(0, disp - necesita) });
    consumos.push({
      ingrediente_id: r.ingrediente_id, nombre: ing.nombre || '',
      cantidad: necesita, unidad: r.unidad || '', costo_linea: Math.round(costoLinea * 100) / 100
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

  // ---------- HISTORIAL ----------
  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    try {
      const { data } = await supabase
        .from('lotes_produccion')
        .select('id, codigo_trazabilidad, cantidad_producida, cantidad_esperada, costo_total, ingredientes_ok, estado, empleado, responsable, notas, fecha, hora_inicio, hora_fin, productos(nombre)')
        .order('fecha', { ascending: false }).limit(60);
      const lotes = (data || []).map(l => {
        const estado = l.estado || 'finalizado';
        const esperada = l.cantidad_esperada == null ? null : Number(l.cantidad_esperada);
        const real = Number(l.cantidad_producida) || 0;
        return {
          id: l.id, codigo: l.codigo_trazabilidad,
          producto: l.productos ? l.productos.nombre : '',
          estado,
          cantidad: real,                 // compat
          cantidadReal: real,
          cantidadEsperada: esperada,
          diferencia: (estado === 'finalizado' && esperada != null) ? real - esperada : null,
          costo: Number(l.costo_total) || 0,
          ingredientesOk: l.ingredientes_ok,
          empleado: l.empleado || l.responsable || '',
          responsable: l.responsable || l.empleado || '',
          notas: l.notas, fecha: l.fecha,
          horaInicio: l.hora_inicio, horaFin: l.hora_fin,
          tiempoMin: minutosEntre(l.hora_inicio, l.hora_fin || (estado === 'finalizado' ? l.fecha : null))
        };
      });
      return ok({
        success: true,
        lotes,
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
        .select('id, producto_id, cantidad_esperada, estado, hora_inicio')
        .eq('id', loteId).maybeSingle();
      if (!lote) return bad(404, 'Lote no encontrado');
      if (lote.estado === 'finalizado') return bad(400, 'El lote ya está finalizado');

      // Sumar el stock REAL producido
      const { data: prod } = await supabase.from('productos').select('stock').eq('id', lote.producto_id).maybeSingle();
      const nuevoStock = (Number(prod && prod.stock) || 0) + real;
      await supabase.from('productos').update({ stock: nuevoStock }).eq('id', lote.producto_id);

      const horaFin = new Date().toISOString();
      const upd = { cantidad_producida: real, estado: 'finalizado', hora_fin: horaFin };
      if (typeof body.notas === 'string' && body.notas.trim() !== '') upd.notas = body.notas.trim();
      await supabase.from('lotes_produccion')
        .update(upd)
        .eq('id', loteId);

      const esperada = Number(lote.cantidad_esperada) || 0;
      return ok({
        success: true, loteId, cantidadReal: real, nuevoStock,
        diferencia: real - esperada,
        tiempoMin: minutosEntre(lote.hora_inicio, horaFin)
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

    // Si falta materia prima y no se forzó, avisar sin tocar nada
    if (faltantes.length && !body.forzar) {
      return ok({ success: false, faltantes, mensaje: 'No alcanza la materia prima para este lote' });
    }

    // Descontar materia prima (consumo al iniciar, igual que el sistema original)
    for (const d of descuentos) {
      await supabase.from('ingredientes').update({ stock_actual: d.nuevo, actualizado_en: new Date().toISOString() }).eq('id', d.id);
    }

    const codigo = await codigoTraza();
    const ahora = new Date().toISOString();
    const empleado = String(body.empleado || body.responsable || '');

    if (esIniciar) {
      // Lote EN PROCESO — el stock del producto se suma al finalizar
      const { data: lote } = await supabase.from('lotes_produccion').insert({
        producto_id: productoId, cantidad_esperada: cantidad, cantidad_producida: 0,
        costo_total: costoTotal, ingredientes_ok: tieneReceta, codigo_trazabilidad: codigo,
        empleado, responsable: empleado, estado: 'en_proceso',
        hora_inicio: ahora, notas: String(body.notas || '')
      }).select('id').maybeSingle();

      if (lote && lote.id && consumos.length) {
        await supabase.from('lote_ingredientes').insert(consumos.map(c => ({ ...c, lote_id: lote.id })));
      }
      return ok({
        success: true, loteId: lote && lote.id, codigoTrazabilidad: codigo, producto: prod.nombre,
        cantidadEsperada: cantidad, costoEstimado: costoTotal, estado: 'en_proceso',
        sinReceta: !tieneReceta
      });
    }

    // LEGACY: un solo paso → finaliza en el acto
    const nuevoStock = (Number(prod.stock) || 0) + cantidad;
    await supabase.from('productos').update({ stock: nuevoStock }).eq('id', productoId);

    const { data: lote } = await supabase.from('lotes_produccion').insert({
      producto_id: productoId, cantidad_esperada: cantidad, cantidad_producida: cantidad,
      costo_total: costoTotal, ingredientes_ok: tieneReceta, codigo_trazabilidad: codigo,
      empleado, responsable: empleado, estado: 'finalizado',
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
