// netlify/functions/merma.js
// POST /api/merma   → registra baja por merma de producto terminado
//   { items:[{productoId, cantidad, motivo?, loteId?}], motivo?, responsable?, token }
//   Por cada ítem: descuenta stock del producto, calcula el costo perdido
//   (cantidad × costo_unitario), linkea el último lote del producto y guarda en 'mermas'.
//
// GET  /api/merma?dias=30&token=...  → reporte de merma del período
//   { totalPerdido, unidades, porProducto[], porDia[], porMotivo[], registros[] }
//
// ⚠️ Requiere correr antes migracion-mermas.sql.

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const qs = event.queryStringParameters || {};
  const got = (event.headers['x-admin-token'] || (body && body.token) || qs.token || '').trim();
  return got === need;
}

const MOTIVOS = ['no_vendido', 'vencido', 'danado', 'otro'];
function normMotivo(m) {
  m = String(m || '').toLowerCase().trim();
  return MOTIVOS.includes(m) ? m : 'no_vendido';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  // ---------- GET: reporte ----------
  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    const dias = Math.min(parseInt((event.queryStringParameters || {}).dias || '30', 10) || 30, 365);
    const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
    try {
      const { data: regs } = await supabase
        .from('mermas')
        .select('id, producto_id, nombre, cantidad, costo_total, motivo, lote_codigo, responsable, fecha, creado_en')
        .gte('fecha', desde)
        .order('creado_en', { ascending: false });

      let totalPerdido = 0, unidades = 0;
      const porProd = {}, porDia = {}, porMot = {};
      (regs || []).forEach(r => {
        const ct = Number(r.costo_total) || 0, cant = Number(r.cantidad) || 0;
        totalPerdido += ct; unidades += cant;
        const n = r.nombre || '—';
        if (!porProd[n]) porProd[n] = { nombre: n, cantidad: 0, costoTotal: 0 };
        porProd[n].cantidad += cant; porProd[n].costoTotal += ct;
        porDia[r.fecha] = (porDia[r.fecha] || 0) + ct;
        porMot[r.motivo] = (porMot[r.motivo] || 0) + ct;
      });

      return ok({
        success: true, dias,
        totalPerdido: Math.round(totalPerdido),
        unidades,
        porProducto: Object.values(porProd)
          .map(p => ({ ...p, costoTotal: Math.round(p.costoTotal) }))
          .sort((a, b) => b.costoTotal - a.costoTotal),
        porDia: Object.entries(porDia).map(([fecha, costoTotal]) => ({ fecha, costoTotal: Math.round(costoTotal) }))
          .sort((a, b) => a.fecha < b.fecha ? -1 : 1),
        porMotivo: Object.entries(porMot).map(([motivo, costoTotal]) => ({ motivo, costoTotal: Math.round(costoTotal) }))
          .sort((a, b) => b.costoTotal - a.costoTotal),
        registros: (regs || []).slice(0, 100)
      });
    } catch (err) { return bad(500, String(err)); }
  }

  // ---------- POST: registrar merma ----------
  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const items = (Array.isArray(body.items) ? body.items : [])
    .map(i => ({ productoId: parseInt(i.productoId, 10), cantidad: Number(i.cantidad) || 0, motivo: i.motivo, loteId: i.loteId }))
    .filter(i => i.productoId && i.cantidad > 0);
  if (!items.length) return bad(400, 'Nada para dar de baja');

  const responsable = String(body.responsable || '').slice(0, 120);
  const motivoGlobal = normMotivo(body.motivo);

  try {
    const ids = items.map(i => i.productoId);

    // Productos (costo y stock actual)
    const { data: prods } = await supabase
      .from('productos').select('id, nombre, stock, costo_unitario').in('id', ids);
    const mapa = {};
    (prods || []).forEach(p => { mapa[p.id] = p; });

    // Último lote finalizado por producto (para linkear la baja al lote)
    const loteDe = {};
    const { data: lotes } = await supabase
      .from('lotes_produccion')
      .select('id, producto_id, codigo_trazabilidad, fecha')
      .in('producto_id', ids).eq('estado', 'finalizado')
      .order('fecha', { ascending: false }).order('id', { ascending: false });
    (lotes || []).forEach(l => { if (loteDe[l.producto_id] === undefined) loteDe[l.producto_id] = l; });

    // Caja abierta (opcional, para asociar la merma al día)
    const { data: caja } = await supabase.from('cajas').select('id').eq('estado', 'abierta')
      .order('abierta_en', { ascending: false }).maybeSingle();

    const filas = [];
    let totalPerdido = 0;
    for (const it of items) {
      const p = mapa[it.productoId];
      if (!p) continue;
      const costoUnit = Number(p.costo_unitario) || 0;
      const costoTotal = Math.round(costoUnit * it.cantidad * 100) / 100;
      totalPerdido += costoTotal;
      const lote = (it.loteId ? { id: it.loteId, codigo_trazabilidad: null } : loteDe[p.id]) || null;
      filas.push({
        producto_id: p.id, nombre: p.nombre, cantidad: it.cantidad,
        costo_unitario: costoUnit, costo_total: costoTotal,
        motivo: normMotivo(it.motivo) === 'no_vendido' && it.motivo == null ? motivoGlobal : normMotivo(it.motivo),
        lote_id: lote ? lote.id : null, lote_codigo: lote ? lote.codigo_trazabilidad : null,
        responsable, caja_id: caja ? caja.id : null
      });
    }
    if (!filas.length) return bad(400, 'Sin productos válidos');

    // Insertar registros de merma
    const { error: errIns } = await supabase.from('mermas').insert(filas);
    if (errIns) return bad(500, errIns.message);

    // Descontar stock de cada producto
    for (const it of items) {
      const p = mapa[it.productoId];
      if (!p) continue;
      const nuevo = Math.max(0, (Number(p.stock) || 0) - it.cantidad);
      await supabase.from('productos').update({ stock: nuevo }).eq('id', p.id);
    }

    return ok({
      success: true,
      registros: filas.length,
      unidades: filas.reduce((a, f) => a + f.cantidad, 0),
      totalPerdido: Math.round(totalPerdido)
    });
  } catch (err) { return bad(500, String(err)); }
};
