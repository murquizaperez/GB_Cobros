// netlify/functions/crear-venta.js
// POST /api/crear-venta
//   { items:[{productoId, cantidad}], medioPago, clienteNombre?, quiereFactura?, facturaCuit?, token }
// Venta inmediata del local (POS): exige caja abierta, descuenta stock,
// registra el movimiento de caja y, si se pide, emite Factura C.

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
  const medioPago = String(body.medioPago || 'Efectivo');

  try {
    // 1) Caja abierta obligatoria
    const { data: caja } = await supabase.from('cajas').select('id, total_ventas').eq('estado', 'abierta')
      .order('abierta_en', { ascending: false }).maybeSingle();
    if (!caja) return bad(409, 'No hay caja abierta. Abrí la caja para vender.');

    // 2) Traer productos y armar líneas con precio minorista (venta al público)
    const ids = items.map(i => parseInt(i.productoId, 10)).filter(Boolean);
    const { data: prods } = await supabase.from('productos').select('id, nombre, precio_minorista, stock').in('id', ids);
    const mapa = {};
    (prods || []).forEach(p => { mapa[p.id] = p; });

    let total = 0;
    const lineas = [];
    for (const it of items) {
      const p = mapa[parseInt(it.productoId, 10)];
      if (!p) continue;
      const cant = Math.max(1, parseInt(it.cantidad, 10) || 1);
      const sub = Number(p.precio_minorista) * cant;
      total += sub;
      lineas.push({ producto_id: p.id, nombre: p.nombre, cantidad: cant, precio_unitario: Number(p.precio_minorista), subtotal: sub, stockActual: Number(p.stock) });
    }
    if (!lineas.length) return bad(400, 'Sin productos válidos');

    // 3) Crear pedido canal 'pos' (venta entregada y pagada)
    const { data: pedido, error: errPed } = await supabase.from('pedidos').insert({
      canal: 'pos', estado: 'entregado', estado_pago: 'pagado',
      medio_pago: medioPago, total, caja_id: caja.id,
      pagado_en: new Date().toISOString(), stock_descontado: true,
      quiere_factura: body.quiereFactura === true, factura_cuit: String(body.facturaCuit || '').replace(/\D/g, ''),
      notas: body.clienteNombre ? ('Cliente: ' + body.clienteNombre) : ''
    }).select('id').maybeSingle();
    if (errPed) return bad(500, errPed.message);

    // 4) Detalle
    await supabase.from('detalle_pedidos').insert(
      lineas.map(l => ({ pedido_id: pedido.id, producto_id: l.producto_id, nombre: l.nombre, cantidad: l.cantidad, precio_unitario: l.precio_unitario, subtotal: l.subtotal }))
    );

    // 5) Descontar stock
    for (const l of lineas) {
      const nuevo = Math.max(0, l.stockActual - l.cantidad);
      await supabase.from('productos').update({ stock: nuevo }).eq('id', l.producto_id);
    }

    // 6) Movimiento de caja + actualizar total de la caja
    await supabase.from('movimientos_caja').insert({ caja_id: caja.id, tipo: 'venta', monto: total, concepto: 'Venta POS #' + pedido.id });
    await supabase.from('cajas').update({ total_ventas: Number(caja.total_ventas || 0) + total }).eq('id', caja.id);

    // 7) Factura opcional
    let factura = null;
    if (body.quiereFactura === true) {
      try {
        const f = await emitirFacturaC({ importeTotal: total, concepto: 'Venta Monnoserie #' + pedido.id, docCliente: String(body.facturaCuit || '').replace(/\D/g, '') });
        await supabase.from('facturas').insert({ pedido_id: pedido.id, afip_numero: f.numeroComprobante, cae: f.cae, cae_vto: f.cae_vto, importe: total, tipo: 'C', punto_venta: f.puntoVenta, qr_url: f.qrUrl, concepto: 'Venta POS #' + pedido.id });
        factura = f.numeroComprobante;
      } catch (e) {
        await supabase.from('facturas').insert({ pedido_id: pedido.id, importe: total, error: String(e.message || e).slice(0, 480) });
      }
    }

    return ok({ success: true, ventaId: pedido.id, total, factura });
  } catch (err) {
    return bad(500, String(err));
  }
};
