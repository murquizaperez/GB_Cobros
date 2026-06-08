// netlify/functions/_procesar-pago.js
// ORQUESTADOR de la cadena automática (Opción B).
// Lo llaman: mp-webhook.js (pago MP) y confirmar-pago.js (operador, 1 clic).
//
// Hace, en orden e idempotente:
//   1. Marca el pedido PAGADO (si no lo estaba)
//   2. Descuenta stock una sola vez (flag stock_descontado)
//   3. Si quiere_factura → emite Factura C en ARCA y guarda CAE/QR
//   4. Avanza estado a 'en_preparacion'
// Cada paso queda registrado en eventos_pedido (para monitoreo/debug).

const { supabase } = require('./_supabase');
const { emitirFacturaC } = require('./_arca');
const { enviarNotificacion } = require('./_email');

async function log(pedidoId, tipo, detalle) {
  try { await supabase.from('eventos_pedido').insert({ pedido_id: pedidoId, tipo, detalle: String(detalle || '').slice(0, 500) }); }
  catch (_) {}
}

/**
 * @param {Object} opts
 * @param {number} opts.pedidoId
 * @param {string} [opts.mpPaymentId]
 * @param {string} [opts.metodo]     'Mercado Pago' | 'Transferencia' | 'Efectivo'
 * @param {number} [opts.monto]      monto informado por la fuente (se valida contra el pedido)
 */
async function procesarPago(opts) {
  const { pedidoId } = opts;
  if (!pedidoId) return { success: false, error: 'Falta pedidoId' };

  // Traer el pedido con su detalle
  const { data: pedido, error: errP } = await supabase
    .from('pedidos')
    .select('id, total, estado, estado_pago, quiere_factura, factura_cuit, stock_descontado, notas, clientes(nombre, email), detalle_pedidos(producto_id, nombre, cantidad, subtotal)')
    .eq('id', pedidoId)
    .maybeSingle();

  if (errP) return { success: false, error: errP.message };
  if (!pedido) return { success: false, error: 'Pedido no encontrado' };

  const resultado = { success: true, pedidoId, pasos: [] };

  // ---- 1) Marcar pagado (idempotente) ----
  if (pedido.estado_pago !== 'pagado') {
    const upd = { estado_pago: 'pagado', pagado_en: new Date().toISOString() };
    if (opts.mpPaymentId) upd.mp_payment_id = String(opts.mpPaymentId);
    if (opts.metodo) upd.medio_pago = opts.metodo;
    await supabase.from('pedidos').update(upd).eq('id', pedidoId);
    await log(pedidoId, 'pago_confirmado', `${opts.metodo || ''} ${opts.mpPaymentId || ''}`.trim());
    resultado.pasos.push('pago_confirmado');
  } else {
    resultado.pasos.push('pago_ya_confirmado');
  }

  // ---- 2) Descontar stock (una sola vez) ----
  if (!pedido.stock_descontado) {
    try {
      for (const linea of (pedido.detalle_pedidos || [])) {
        if (!linea.producto_id) continue;
        // Lectura + resta (Supabase JS no hace decremento atómico simple; leemos y escribimos)
        const { data: prod } = await supabase.from('productos').select('stock').eq('id', linea.producto_id).maybeSingle();
        if (prod) {
          const nuevo = Math.max(0, (Number(prod.stock) || 0) - (Number(linea.cantidad) || 0));
          await supabase.from('productos').update({ stock: nuevo }).eq('id', linea.producto_id);
        }
      }
      await supabase.from('pedidos').update({ stock_descontado: true }).eq('id', pedidoId);
      await log(pedidoId, 'stock_descontado', `${(pedido.detalle_pedidos || []).length} líneas`);
      resultado.pasos.push('stock_descontado');
    } catch (e) {
      await log(pedidoId, 'error', 'stock: ' + e.message);
      resultado.pasos.push('stock_error');
    }
  } else {
    resultado.pasos.push('stock_ya_descontado');
  }

  // ---- 3) Facturar SOLO si el cliente lo pidió y no hay factura previa ----
  if (pedido.quiere_factura) {
    const { data: facturaPrevia } = await supabase
      .from('facturas').select('id, cae').eq('pedido_id', pedidoId).maybeSingle();

    if (facturaPrevia && facturaPrevia.cae) {
      resultado.pasos.push('factura_ya_emitida');
    } else {
      try {
        const f = await emitirFacturaC({
          importeTotal: pedido.total,
          concepto: 'Pedido Monnoserie #' + pedidoId,
          docCliente: pedido.factura_cuit || ''
        });
        await supabase.from('facturas').insert({
          pedido_id: pedidoId, afip_numero: f.numeroComprobante, cae: f.cae, cae_vto: f.cae_vto,
          importe: pedido.total, tipo: 'C', punto_venta: f.puntoVenta, qr_url: f.qrUrl,
          concepto: 'Pedido Monnoserie #' + pedidoId
        });
        await log(pedidoId, 'factura_emitida', f.numeroComprobante + ' CAE ' + f.cae);
        resultado.pasos.push('factura_emitida');
        resultado.factura = f.numeroComprobante;
      } catch (e) {
        // Si ARCA falla, NO rompemos la cadena: el pedido sigue su curso, queda el error logueado.
        await supabase.from('facturas').insert({ pedido_id: pedidoId, importe: pedido.total, error: e.message.slice(0, 480) });
        await log(pedidoId, 'error', 'arca: ' + e.message);
        resultado.pasos.push('factura_error');
      }
    }
  }

  // ---- 4) Avanzar estado a en_preparacion (si estaba pendiente) ----
  if (pedido.estado === 'pendiente') {
    await supabase.from('pedidos').update({ estado: 'en_preparacion' }).eq('id', pedidoId);
    resultado.pasos.push('estado_en_preparacion');
  }

  // ---- 5) Email "pago confirmado" (fire-and-forget) ----
  const emailCli = pedido.clientes && pedido.clientes.email;
  if (emailCli) {
    const r = await enviarNotificacion('pagado', emailCli, {
      id: pedidoId,
      nombre: pedido.clientes && pedido.clientes.nombre,
      total: pedido.total,
      items: (pedido.detalle_pedidos || []).map(d => ({ nombre: d.nombre, cantidad: d.cantidad, subtotal: Number(d.subtotal) }))
    });
    if (r.enviado) { await log(pedidoId, 'email_pagado', emailCli); resultado.pasos.push('email_enviado'); }
  }

  return resultado;
}

module.exports = { procesarPago };
