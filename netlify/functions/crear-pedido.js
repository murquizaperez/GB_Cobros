// netlify/functions/crear-pedido.js
// POST /api/crear-pedido
// Body: { canal, cliente:{nombre,telefono,email,dniCuit,direccion}, fechaEntrega, notas, medioPago, items:[{productoId,cantidad}] }
//
// Reglas clave:
//  - El cliente DEBE existir (validación por teléfono). Si no existe, se rechaza.
//    (El registro de clientes se hace por separado en registrar-cliente.js)
//  - Los precios NUNCA se confían del frontend: se recalculan leyendo la DB.
//  - El total se calcula en el servidor.

const { supabase, ok, bad, preflight } = require('./_supabase');
const { enviarNotificacion } = require('./_email');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }

  const canal = body.canal === 'mayorista' ? 'mayorista' : 'minorista';
  const cli = body.cliente || {};
  const telefono = String(cli.telefono || '').trim();
  const items = Array.isArray(body.items) ? body.items : [];
  const quiereFactura = body.quiereFactura === true;
  const facturaCuit = String(body.facturaCuit || '').replace(/\D/g, '');

  if (!telefono) return bad(400, 'Falta el teléfono del cliente');
  if (!items.length) return bad(400, 'El pedido no tiene productos');

  try {
    // 1) Validar cliente registrado (por teléfono). Si no existe → rechazo.
    const { data: cliente, error: errCli } = await supabase
      .from('clientes')
      .select('id, nombre, tipo, email')
      .eq('telefono', telefono)
      .maybeSingle();

    if (errCli) return bad(500, errCli.message);
    if (!cliente) {
      return bad(403, 'CLIENTE_NO_REGISTRADO'); // el frontend muestra el alta
    }

    // 2) Traer los productos reales de la DB para recalcular precios (anti-fraude)
    const ids = items.map(i => Number(i.productoId)).filter(Boolean);
    const { data: productos, error: errProd } = await supabase
      .from('productos')
      .select('id, nombre, precio_minorista, precio_mayorista, activo')
      .in('id', ids);

    if (errProd) return bad(500, errProd.message);

    const mapa = {};
    (productos || []).forEach(p => { mapa[p.id] = p; });

    // 3) Construir las líneas con precio de servidor
    let total = 0;
    const lineas = [];
    for (const it of items) {
      const prod = mapa[Number(it.productoId)];
      if (!prod || !prod.activo) continue;
      const cantidad = Math.max(1, parseInt(it.cantidad, 10) || 1);
      const precio = canal === 'mayorista' ? Number(prod.precio_mayorista) : Number(prod.precio_minorista);
      const subtotal = precio * cantidad;
      total += subtotal;
      lineas.push({
        producto_id: prod.id,
        nombre: prod.nombre,
        cantidad,
        precio_unitario: precio,
        subtotal
      });
    }

    if (!lineas.length) return bad(400, 'Ningún producto válido en el pedido');

    // 4) Crear el pedido (cabecera)
    const { data: pedido, error: errPed } = await supabase
      .from('pedidos')
      .insert({
        cliente_id: cliente.id,
        canal,
        fecha_entrega: body.fechaEntrega || null,
        notas: String(body.notas || '').trim(),
        medio_pago: String(body.medioPago || 'Transferencia'),
        direccion: String(cli.direccion || '').trim(),
        quiere_factura: quiereFactura,
        factura_cuit: facturaCuit,
        total
      })
      .select('id')
      .single();

    if (errPed) return bad(500, errPed.message);

    // 5) Insertar el detalle
    const detalle = lineas.map(l => ({ ...l, pedido_id: pedido.id }));
    const { error: errDet } = await supabase.from('detalle_pedidos').insert(detalle);
    if (errDet) return bad(500, errDet.message);

    // 6) Email "recibido" (no frena nada si falla o no hay email)
    if (cliente.email) {
      await enviarNotificacion('recibido', cliente.email, {
        id: pedido.id, nombre: cliente.nombre, total,
        items: lineas.map(l => ({ nombre: l.nombre, cantidad: l.cantidad, subtotal: l.subtotal }))
      });
    }

    return ok({
      success: true,
      pedidoId: pedido.id,
      total,
      medioPago: String(body.medioPago || 'Transferencia'),
      items: lineas.map(l => ({ nombre: l.nombre, cantidad: l.cantidad, subtotal: l.subtotal }))
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
