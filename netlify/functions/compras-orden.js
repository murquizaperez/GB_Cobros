// netlify/functions/compras-orden.js
// Órdenes de Compra / Almacén (pasos 1-4 del proceso Monnoserie)
//
// Flujo:
//   1-2) crear   → listado multi-ítem, queda 'pendiente' (NO toca stock)
//   2-3) recibir → llega la mercadería, se hace el CHECK (pedido vs recibido), queda 'recibida'
//     4) cargar  → se acepta y se carga: suma stock, actualiza costos, historial en 'compras'
//        anular  → descarta la orden (si todavía no se cargó)
//
// POST { accion:'crear',  proveedor?, responsable?, notas?, items:[{ingredienteId,cantidad,costoUnitario}], token }
// POST { accion:'recibir', ordenId, items:[{itemId, cantidadRecibida, costoUnitario?}], token }
// POST { accion:'cargar',  ordenId, token }
// POST { accion:'anular',  ordenId, token }
// GET  ?estado=...&token=...  → lista de órdenes con sus ítems

const { supabase, ok, bad, preflight } = require('./_supabase');
let recalcularCostos;
try { ({ recalcularCostos } = require('./_costos')); } catch (e) { recalcularCostos = null; }

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (body && body.token) ||
    (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  // ---------- LISTAR ----------
  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    try {
      const estado = (event.queryStringParameters || {}).estado;
      let q = supabase.from('ordenes_compra')
        .select('*, orden_compra_items(*)')
        .order('creada_en', { ascending: false }).limit(80);
      if (estado) q = q.eq('estado', estado);
      const { data } = await q;
      const ordenes = (data || []).map(o => ({
        id: o.id, proveedor: o.proveedor, estado: o.estado, notas: o.notas,
        responsable: o.responsable,
        totalEstimado: Number(o.total_estimado) || 0,
        totalReal: o.total_real == null ? null : Number(o.total_real),
        creadaEn: o.creada_en, recibidaEn: o.recibida_en, cargadaEn: o.cargada_en,
        items: (o.orden_compra_items || []).map(it => ({
          id: it.id, ingredienteId: it.ingrediente_id, nombre: it.nombre,
          cantidadPedida: Number(it.cantidad_pedida) || 0,
          cantidadRecibida: it.cantidad_recibida == null ? null : Number(it.cantidad_recibida),
          costoUnitario: Number(it.costo_unitario) || 0,
          subtotal: Number(it.subtotal) || 0
        })).sort((a, b) => a.id - b.id)
      }));
      return ok({ success: true, ordenes });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');
  const accion = String(body.accion || '').trim();

  try {
    // ---------- 1) CREAR ORDEN (listado pendiente) ----------
    if (accion === 'crear') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return bad(400, 'La orden no tiene ítems');

      // snapshot de nombres de ingredientes
      const ids = items.map(i => parseInt(i.ingredienteId, 10)).filter(Boolean);
      const { data: ings } = await supabase.from('ingredientes').select('id, nombre').in('id', ids);
      const nombreDe = Object.fromEntries((ings || []).map(i => [i.id, i.nombre]));

      let totalEst = 0;
      const filas = [];
      for (const it of items) {
        const ingId = parseInt(it.ingredienteId, 10);
        const cant = Number(it.cantidad);
        const costo = Number(it.costoUnitario);
        if (!ingId || !(cant > 0) || !(costo >= 0)) continue;
        const sub = r2(cant * costo);
        totalEst += sub;
        filas.push({ ingrediente_id: ingId, nombre: nombreDe[ingId] || '', cantidad_pedida: cant, costo_unitario: costo, subtotal: sub });
      }
      if (!filas.length) return bad(400, 'Ítems inválidos');

      const { data: orden, error } = await supabase.from('ordenes_compra').insert({
        proveedor: String(body.proveedor || ''), responsable: String(body.responsable || ''),
        notas: String(body.notas || ''), estado: 'pendiente', total_estimado: r2(totalEst)
      }).select('id').maybeSingle();
      if (error) return bad(500, error.message);

      await supabase.from('orden_compra_items').insert(filas.map(f => ({ ...f, orden_id: orden.id })));
      return ok({ success: true, ordenId: orden.id, totalEstimado: r2(totalEst), estado: 'pendiente' });
    }

    // ---------- 2-3) RECIBIR (check pedido vs recibido) ----------
    if (accion === 'recibir') {
      const ordenId = parseInt(body.ordenId, 10);
      if (!ordenId) return bad(400, 'Falta ordenId');
      const { data: orden } = await supabase.from('ordenes_compra').select('id, estado').eq('id', ordenId).maybeSingle();
      if (!orden) return bad(404, 'Orden no encontrada');
      if (orden.estado === 'cargada') return bad(400, 'La orden ya fue cargada a stock');

      const items = Array.isArray(body.items) ? body.items : [];
      let totalReal = 0;
      for (const it of items) {
        const itemId = parseInt(it.itemId, 10);
        if (!itemId) continue;
        const recibida = Number(it.cantidadRecibida);
        const upd = { cantidad_recibida: recibida >= 0 ? recibida : 0 };
        if (it.costoUnitario != null && Number(it.costoUnitario) >= 0) upd.costo_unitario = Number(it.costoUnitario);
        // recomputar subtotal sobre lo recibido
        const { data: actual } = await supabase.from('orden_compra_items').select('costo_unitario').eq('id', itemId).maybeSingle();
        const costo = upd.costo_unitario != null ? upd.costo_unitario : Number(actual && actual.costo_unitario) || 0;
        upd.subtotal = r2((upd.cantidad_recibida || 0) * costo);
        totalReal += upd.subtotal;
        await supabase.from('orden_compra_items').update(upd).eq('id', itemId);
      }
      await supabase.from('ordenes_compra').update({
        estado: 'recibida', recibida_en: new Date().toISOString(), total_real: r2(totalReal)
      }).eq('id', ordenId);
      return ok({ success: true, ordenId, estado: 'recibida', totalReal: r2(totalReal) });
    }

    // ---------- 4) CARGAR A STOCK ----------
    if (accion === 'cargar') {
      const ordenId = parseInt(body.ordenId, 10);
      if (!ordenId) return bad(400, 'Falta ordenId');
      const { data: orden } = await supabase.from('ordenes_compra').select('id, estado, proveedor').eq('id', ordenId).maybeSingle();
      if (!orden) return bad(404, 'Orden no encontrada');
      if (orden.estado === 'cargada') return ok({ success: true, ordenId, estado: 'cargada', yaCargada: true });
      if (orden.estado === 'anulada') return bad(400, 'La orden está anulada');

      const { data: items } = await supabase.from('orden_compra_items').select('*').eq('orden_id', ordenId);
      if (!items || !items.length) return bad(400, 'La orden no tiene ítems');

      const afectados = new Set();
      for (const it of items) {
        // si no se hizo el check, se carga lo pedido
        const cant = it.cantidad_recibida == null ? Number(it.cantidad_pedida) : Number(it.cantidad_recibida);
        if (!(cant > 0)) continue;
        const costo = Number(it.costo_unitario) || 0;

        const { data: ing } = await supabase.from('ingredientes').select('stock_actual').eq('id', it.ingrediente_id).maybeSingle();
        if (!ing) continue;
        const nuevoStock = (Number(ing.stock_actual) || 0) + cant;
        await supabase.from('ingredientes').update({
          stock_actual: nuevoStock, costo_unitario: costo, actualizado_en: new Date().toISOString()
        }).eq('id', it.ingrediente_id);

        // historial de precios (misma tabla que registrar-compra)
        await supabase.from('compras').insert({
          ingrediente_id: it.ingrediente_id, cantidad: cant, costo_unitario: costo,
          total: r2(cant * costo), proveedor: orden.proveedor || ''
        });
        afectados.add(it.ingrediente_id);
      }

      await supabase.from('ordenes_compra').update({ estado: 'cargada', cargada_en: new Date().toISOString() }).eq('id', ordenId);

      // recalcular costo de productos que usan esos ingredientes
      let recalculados = 0;
      if (recalcularCostos && afectados.size) {
        const { data: recs } = await supabase.from('recetas').select('producto_id').in('ingrediente_id', [...afectados]);
        const prodIds = [...new Set((recs || []).map(r => r.producto_id))];
        if (prodIds.length) { const res = await recalcularCostos(prodIds); recalculados = (res && res.actualizados) || 0; }
      }
      return ok({ success: true, ordenId, estado: 'cargada', ingredientesCargados: afectados.size, productosRecalculados: recalculados });
    }

    // ---------- ANULAR ----------
    if (accion === 'anular') {
      const ordenId = parseInt(body.ordenId, 10);
      if (!ordenId) return bad(400, 'Falta ordenId');
      const { data: orden } = await supabase.from('ordenes_compra').select('estado').eq('id', ordenId).maybeSingle();
      if (!orden) return bad(404, 'Orden no encontrada');
      if (orden.estado === 'cargada') return bad(400, 'No se puede anular una orden ya cargada a stock');
      await supabase.from('ordenes_compra').update({ estado: 'anulada' }).eq('id', ordenId);
      return ok({ success: true, ordenId, estado: 'anulada' });
    }

    return bad(400, 'Acción inválida');
  } catch (err) {
    return bad(500, String(err));
  }
};
