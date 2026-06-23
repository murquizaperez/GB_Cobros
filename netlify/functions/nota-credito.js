// netlify/functions/nota-credito.js
// POST /api/nota-credito { pedidoId, token }
//   Emite una Nota de Crédito C (CbteTipo 13) que anula/credita la factura del pedido.
//   - Lee la factura original (con CAE) del pedido.
//   - Emite la NC en ARCA asociada a esa factura.
//   - Guarda la NC en 'facturas' (tipo 'NC', factura_ref = id de la original) con snapshot.
//   Devuelve { success, datos } con el comprobante listo para imprimir (verFacturaC).
//
//   NO cancela el pedido ni restaura stock automáticamente (decisión del operador).

const { supabase, ok, bad, preflight } = require('./_supabase');
const { emitirNotaCreditoC } = require('./_arca');
const { construirSnapshot } = require('./_factura-snapshot');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const qs = event.queryStringParameters || {};
  const got = (event.headers['x-admin-token'] || (body && body.token) || qs.token || '').trim();
  return got === need;
}

async function log(pedidoId, tipo, detalle) {
  try { await supabase.from('eventos_pedido').insert({ pedido_id: pedidoId, tipo, detalle: String(detalle || '').slice(0, 500) }); }
  catch (_) {}
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const pedidoId = parseInt(body.pedidoId, 10);
  if (!pedidoId) return bad(400, 'Falta pedidoId');

  try {
    const { data: pedido } = await supabase
      .from('pedidos').select('id, total, factura_cuit').eq('id', pedidoId).maybeSingle();
    if (!pedido) return bad(404, 'Pedido no encontrado');

    // facturas del pedido (varias filas posibles: C, NC, fallidas)
    const { data: facs } = await supabase
      .from('facturas').select('*').eq('pedido_id', pedidoId)
      .order('id', { ascending: false }).limit(10);
    const lista = facs || [];

    // ¿ya hay una NC emitida?
    const ncPrevia = lista.find(f => f.tipo === 'NC' && f.cae);
    if (ncPrevia) {
      return ok({ success: false, error: 'Este pedido ya tiene una Nota de Crédito emitida (' + (ncPrevia.afip_numero || '') + ')' });
    }

    // factura original a anular: la C con CAE
    const original = lista.find(f => f.cae && f.tipo !== 'NC');
    if (!original) return bad(400, 'El pedido no tiene una factura emitida para anular');

    // punto de venta + número de la original (preferimos columnas; si no, parseamos afip_numero)
    let ptoVtaOrig = parseInt(original.punto_venta, 10) || 0;
    let numeroOrig = parseInt(original.numero, 10) || 0;
    if (!numeroOrig) {
      const raw = String(original.afip_numero || '');
      if (raw.includes('-')) {
        const p = raw.split('-');
        ptoVtaOrig = parseInt(p[0], 10) || ptoVtaOrig;
        numeroOrig = parseInt(p[1], 10) || 0;
      } else {
        numeroOrig = parseInt(raw, 10) || 0;
      }
    }
    if (!numeroOrig) return bad(400, 'No se pudo determinar el número de la factura original');

    const importe = Number(original.importe) || Number(pedido.total) || 0;

    // emitir NC en ARCA
    let f;
    try {
      f = await emitirNotaCreditoC({
        importeTotal: importe,
        docCliente: pedido.factura_cuit || '',
        original: { puntoVenta: ptoVtaOrig, numero: numeroOrig }
      });
    } catch (e) {
      const msg = (e.message || String(e)).slice(0, 480);
      await log(pedidoId, 'nota_credito_error', msg);
      return ok({ success: false, error: msg });
    }

    // snapshot de la NC (mismo contenido que la factura, tipoComprobante 13)
    let snapshot = null;
    try {
      snapshot = await construirSnapshot(supabase, pedidoId, {
        puntoVenta: f.puntoVenta, afipNumero: f.numeroComprobante,
        cae: f.cae, caeVto: f.cae_vto, qrUrl: f.qrUrl, fecha: f.fecha,
        importe, tipoComprobante: 13
      });
    } catch (_) {}

    await supabase.from('facturas').insert({
      pedido_id: pedidoId, afip_numero: f.numeroComprobante, numero: f.numero, fecha: f.fecha,
      cae: f.cae, cae_vto: f.cae_vto, importe, tipo: 'NC',
      punto_venta: f.puntoVenta, qr_url: f.qrUrl, factura_ref: original.id,
      concepto: 'NC pedido Monnoserie #' + pedidoId, snapshot
    });
    await log(pedidoId, 'nota_credito_emitida', f.numeroComprobante + ' CAE ' + f.cae);

    return ok({ success: true, numero: f.numeroComprobante, cae: f.cae, datos: snapshot });
  } catch (e) {
    return bad(500, e.message || 'Error');
  }
};
