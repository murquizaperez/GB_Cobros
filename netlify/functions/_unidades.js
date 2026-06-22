// netlify/functions/_unidades.js
// CONVENCIÓN ÚNICA DE UNIDADES DEL SISTEMA (la regla vive acá y en ningún otro lado).
//
//  • Las CANTIDADES se guardan siempre en unidad base:
//      - g   para insumos en Kg
//      - ml  para insumos en L
//      - u   para insumos por unidad
//    Esto aplica a: ingredientes.stock_actual, ingredientes.stock_minimo,
//    recetas.cantidad y mermas.cantidad.
//
//  • ingredientes.costo_unitario está por Kg / L / unidad  (NO por gramo).
//
//  ⇒ Para pasar de "cantidad base" a PESOS hay que multiplicar por 0.001 cuando
//    el insumo es Kg o L (porque el costo es por 1000 g/ml). Para 'unidad', factor 1.
//
//  Mientras todas las cantidades estén en base g/ml, las COMPARACIONES de cantidad
//  (stock vs mínimo, necesita vs stock) NO necesitan factor: son misma escala.
//  El factor ÷1000 SOLO aparece cuando se cruza cantidad × costo.

function esMasaOVolumen(unidad) {
  const u = String(unidad || '').toLowerCase().trim();
  return u === 'kg' || u === 'l';
}

// factor para (cantidad_base * costo_unitario) → $
function factorCosto(unidad) { return esMasaOVolumen(unidad) ? 0.001 : 1; }

// $ de una cantidad base de un insumo
function valorStock(cantidadBase, costoUnitario, unidad) {
  return (Number(cantidadBase) || 0) * (Number(costoUnitario) || 0) * factorCosto(unidad);
}

// Texto legible: 1500 (Kg) → "1.50 Kg" ; 800 (Kg) → "800 g" ; 3 (unidad) → "3 u"
function fmtCantidad(cantidadBase, unidad) {
  const u = String(unidad || '').toLowerCase().trim();
  const n = Number(cantidadBase) || 0;
  if (u === 'kg') return n >= 1000 ? (n / 1000).toFixed(2) + ' Kg' : Math.round(n) + ' g';
  if (u === 'l')  return n >= 1000 ? (n / 1000).toFixed(2) + ' L'  : Math.round(n) + ' ml';
  return Math.round(n) + ' u';
}

module.exports = { esMasaOVolumen, factorCosto, valorStock, fmtCantidad };
