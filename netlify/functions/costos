// netlify/functions/_costos.js
// Recalcula el costo de producción de los productos a partir de sus recetas,
// convirtiendo unidades (g↔Kg, ml↔L). Reutilizable por registrar-compra y recalcular-costos.

const { supabase } = require('./_supabase');

// Normaliza una unidad a su base y factor hacia la base.
// masa → g, volumen → ml, conteo → u
function baseDe(unidad) {
  const u = String(unidad || '').toLowerCase().trim().replace('.', '');
  if (['kg'].includes(u)) return { base: 'g', factor: 1000 };
  if (['g', 'gr'].includes(u)) return { base: 'g', factor: 1 };
  if (['l', 'lt', 'lts'].includes(u)) return { base: 'ml', factor: 1000 };
  if (['ml', 'cc'].includes(u)) return { base: 'ml', factor: 1 };
  return { base: 'u', factor: 1 }; // unidad, unid, etc.
}

// Costo de "cantidad" de un ingrediente dentro de una receta.
// cantRec en unidadRec; el ingrediente cuesta costoIng por unidadIng.
function costoLinea(cantRec, unidadRec, costoIng, unidadIng) {
  const r = baseDe(unidadRec), i = baseDe(unidadIng);
  // costo del ingrediente por su unidad base
  const costoPorBase = costoIng / i.factor;       // ej: $850/Kg → $0.85/g
  const cantEnBase = (Number(cantRec) || 0) * r.factor; // ej: 80g → 80g
  // si las bases no coinciden (g vs ml), igual multiplicamos (no convertimos masa↔volumen)
  return cantEnBase * costoPorBase;
}

/**
 * Recalcula el costo_unitario de uno o todos los productos desde sus recetas.
 * @param {number[]|null} productoIds  ids a recalcular; null = todos los que tengan receta
 * @returns {Promise<{actualizados:number, detalle:Array}>}
 */
async function recalcularCostos(productoIds = null) {
  // Traer recetas con costo y unidad del ingrediente
  let q = supabase.from('recetas')
    .select('producto_id, cantidad, unidad, ingredientes(costo_unitario, unidad)');
  if (productoIds && productoIds.length) q = q.in('producto_id', productoIds);
  const { data: recetas } = await q;

  // Agrupar por producto
  const porProducto = {};
  (recetas || []).forEach(r => {
    const ing = r.ingredientes || {};
    const costo = costoLinea(r.cantidad, r.unidad, Number(ing.costo_unitario) || 0, ing.unidad);
    porProducto[r.producto_id] = (porProducto[r.producto_id] || 0) + costo;
  });

  const detalle = [];
  for (const [pid, costo] of Object.entries(porProducto)) {
    const c = Math.round(costo * 100) / 100;
    await supabase.from('productos').update({ costo_unitario: c }).eq('id', pid);
    detalle.push({ productoId: Number(pid), costo: c });
  }
  return { actualizados: detalle.length, detalle };
}

module.exports = { recalcularCostos, costoLinea };
