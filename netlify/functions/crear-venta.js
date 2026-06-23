// netlify/functions/crear-venta.js
// POST /api/crear-venta
//   { items:[{productoId, cantidad}], medioPago, clienteNombre?, quiereFactura?, facturaCuit?, esRegalo?, token }
// Venta inmediata del local (POS): exige caja abierta, descuenta stock,
// registra el movimiento de caja y, si se pide, emite Factura C.
//
// REGALO (esRegalo:true): la mercadería sale igual (descuenta stock y estampa
//   el lote para trazabilidad) pero NO se cobra: total 0, medio 'Regalo',
//   sin movimiento de caja y sin factura. Queda marcado es_regalo=true.
//
// ⚠️ Requiere correr antes:
//    - migracion-trazabilidad.sql (columnas lote_id / lote_codigo en detalle_pedidos)
//    - migracion-reportes.sql     (columna es_regalo en pedidos)

const { supabase, ok, bad, preflight } = require('./_supabase');
const { emitirFacturaC } = require('./_arca');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (body && body.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return bad(400, 'Carrito vacío');
  const esRegalo = body.esRegalo === true;
  const medioPago = esRegalo ? 'Regalo' : String(body.medioPago || 'Efectivo');

  try {
    // 1) Caja abierta obligatoria (también para regalos: es un movimiento del local)
    const { data: caja } = await supabase.from('cajas').select('id, total_ventas').eq('estado', 'abierta')
      .order('abierta_en', { ascending: false }).maybeSingle();
    if (!caja) return bad(409, 'No hay caja abierta. Abrí la caja para vender.');

    // 2) Traer productos y armar líneas con precio minorista (venta al público)
    const ids = items.map(i => parseInt(i.productoId, 10)).filter(Boolean);
    const { data: prods } = await supabase.from('productos').select('id, nombre, precio_minorista, stock').in('id', ids);
    const mapa = {};
    (prods || []).forEach(p => { mapa[p.id] = p; });

    // 2b) Último lote finalizado de cada producto → trazabilidad venta→lote.
    const loteDe = {};
    const { data: lotes } = await supabase
      .from('lotes_produccion')
      .select('id, producto_id, codigo_trazabilidad, fecha')
      .in('producto_id', ids)
      .eq('estado', 'finalizado')
      .order('fecha', { ascending: false })
      .order('id', { ascending: false });
    (lotes || []).forEach(l => { if (loteDe[l.producto_id] === undefined) loteDe[l.producto_id] = l; });

    let totalReal = 0;
    const lineas = [];
    for (const it of items) {
      const p = mapa[parseInt(it.productoId, 10)];
      if (!p) continue;
      const cant = Math.max(1, parseInt(it.cantidad, 10) || 1);
      const sub = Number(p.precio_minorista) * cant;
      totalReal += sub;
      const lote = loteDe[p.id] || null;
      lineas.push({
        producto_id: p.id, nombre: p.nombre, cantidad: cant,
        precio_unitario: Number(p.precio_minorista), subtotal: sub, stockActual: Number(p.stock),
        lote_id: lote ? lote.id : null, lote_codigo: lote ? lote.codigo_trazabilidad : null
      });
    }
    if (!lineas.length) return bad(400, 'Sin productos válidos');

    // Total cobrado: 0 si es regalo
    const total = esRegalo ? 0 : totalReal;

    // 3) Crear pedido canal 'pos'
    const { data: pedido, error: errPed } = await supabase.from('pedidos').insert({
      canal: 'pos', estado: 'entregado', estado_pago: 'pagado',
      medio_pago: medioPago, total, caja_id: caja.id, es_regalo: esRegalo,
      pagado_en: new Date().toISOString(), stock_descontado: true,
      quiere_factura: !esRegalo && body.quiereFactura === true,
      factura_cuit: String(body.facturaCuit || '').replace(/\D/g, ''),
      notas: (esRegalo ? '[REGALO] ' : '') + (body.clienteNombre ? ('Cliente: ' + body.clienteNombre) : '')
    }).select('id').maybeSingle();
    if (errPed) return bad(500, errPed.message);

    // 4) Detalle (con lote estampado; en regalo el subtotal va en 0)
    await supabase.from('detalle_pedidos').insert(
      lineas.map(l => ({
        pedido_id: pedido.id, producto_id: l.producto_id, nombre: l.nombre,
        cantidad: l.cantidad, precio_unitario: l.precio_unitario,
        subtotal: esRegalo ? 0 : l.subtotal,
        lote_id: l.lote_id, lote_codigo: l.lote_codigo
      }))
    );

    // 5) Descontar stock (siempre: la mercadería sale). Si se vende más de lo que
    //    hay, se clampa a 0 PERO se registra la sobreventa (señal de error de conteo).
    const sobreventas = [];
    for (const l of lineas) {
      if (l.cantidad > l.stockActual) {
        sobreventas.push({
          producto_id: l.producto_id, nombre: l.nombre,
          vendidas: l.cantidad, stock_previo: l.stockActual,
          faltante: l.cantidad - l.stockActual, pedido_id: pedido.id
        });
      }
      // Descuento atómico en la base (evita pisarse con ventas simultáneas).
      await supabase.rpc('descontar_stock_producto', { p_id: l.producto_id, p_cant: Number(l.cantidad) || 0 });
    }
    // Registrar sobreventas (resiliente: si la tabla no existe todavía, no rompe la venta)
    if (sobreventas.length) {
      try { await supabase.from('sobreventas').insert(sobreventas); } catch (e) { /* tabla aún no creada */ }
    }

    // 6) Caja: solo si NO es regalo (un regalo no ingresa plata)
    if (!esRegalo) {
      await supabase.from('movimientos_caja').insert({ caja_id: caja.id, tipo: 'venta', monto: total, concepto: 'Venta POS #' + pedido.id });
      await supabase.from('cajas').update({ total_ventas: Number(caja.total_ventas || 0) + total }).eq('id', caja.id);
    }

    // 7) Factura opcional (nunca para regalos)
    let factura = null;
    if (!esRegalo && body.quiereFactura === true) {
      try {
        const f = await emitirFacturaC({ importeTotal: total, concepto: 'Venta Monnoserie #' + pedido.id, docCliente: String(body.facturaCuit || '').replace(/\D/g, '') });
        await supabase.from('facturas').insert({ pedido_id: pedido.id, afip_numero: f.numeroComprobante, cae: f.cae, cae_vto: f.cae_vto, importe: total, tipo: 'C', punto_venta: f.puntoVenta, qr_url: f.qrUrl, concepto: 'Venta POS #' + pedido.id });
        factura = f.numeroComprobante;
      } catch (e) {
        await supabase.from('facturas').insert({ pedido_id: pedido.id, importe: total, error: String(e.message || e).slice(0, 480) });
      }
    }

    return ok({ success: true, ventaId: pedido.id, total, esRegalo, factura });
  } catch (err) {
    return bad(500, String(err));
  }
};
