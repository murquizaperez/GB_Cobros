// netlify/functions/factura-reintentar.js
// GET  /api/factura-reintentar?token=...        → lista facturas que fallaron (error, sin CAE)
// POST /api/factura-reintentar { pedidoId, token } → reintenta emitir esa factura en ARCA
//
// Reusa la misma emisión que _procesar-pago, sin tocar la cadena: si ARCA falla
// (típico corte de TLS), el operador reintenta con 1 clic desde el panel.

const { supabase, ok, bad, preflight } = require('./_supabase');
const { emitirFacturaC } = require('./_arca');
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

  // ---------- GET: listar fallidas ----------
  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    try {
      const { data } = await supabase
        .from('facturas')
        .select('id, pedido_id, importe, error')
        .not('error', 'is', null)
        .is('cae', null)
        .order('id', { ascending: false })
        .limit(100);

      // contexto del pedido (cliente) en una segunda consulta, tolerante
      const ids = [...new Set((data || []).map(f => f.pedido_id).filter(Boolean))];
      const ctx = {};
      if (ids.length) {
        const { data: peds } = await supabase
          .from('pedidos')
          .select('id, total, estado, canal, clientes(nombre)')
          .in('id', ids);
        (peds || []).forEach(p => { ctx[p.id] = p; });
      }

      const fallidas = (data || []).map(f => {
        const p = ctx[f.pedido_id] || {};
        return {
          facturaId: f.id,
          pedidoId: f.pedido_id,
          importe: Number(f.importe) || 0,
          error: f.error || '',
          cliente: (p.clientes && p.clientes.nombre) || '',
          canal: p.canal || '',
          estado: p.estado || ''
        };
      });

      return ok({ success: true, total: fallidas.length, fallidas });
    } catch (e) {
      return bad(500, e.message || 'Error');
    }
  }

  // ---------- POST: reintentar una ----------
  if (event.httpMethod === 'POST') {
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

      // ¿ya hay una factura buena?
      const { data: buena } = await supabase
        .from('facturas').select('id, cae, afip_numero').eq('pedido_id', pedidoId)
        .not('cae', 'is', null).maybeSingle();
      if (buena && buena.cae) {
        return ok({ success: true, yaEmitida: true, numero: buena.afip_numero, cae: buena.cae });
      }

      // fila fallida a actualizar (si existe)
      const { data: fallida } = await supabase
        .from('facturas').select('id').eq('pedido_id', pedidoId).is('cae', null)
        .order('id', { ascending: false }).limit(1).maybeSingle();

      try {
        const f = await emitirFacturaC({
          importeTotal: pedido.total,
          concepto: 'Pedido Monnoserie #' + pedidoId,
          docCliente: pedido.factura_cuit || ''
        });

        let snapshot = null;
        try {
          snapshot = await construirSnapshot(supabase, pedidoId, {
            puntoVenta: f.puntoVenta, afipNumero: f.numeroComprobante,
            cae: f.cae, caeVto: f.cae_vto, qrUrl: f.qrUrl, fecha: f.fecha, importe: pedido.total
          });
        } catch (_) {}

        const fila = {
          afip_numero: f.numeroComprobante, numero: f.numero, fecha: f.fecha, cae: f.cae, cae_vto: f.cae_vto,
          importe: pedido.total, tipo: 'C', punto_venta: f.puntoVenta, qr_url: f.qrUrl,
          concepto: 'Pedido Monnoserie #' + pedidoId, snapshot, error: null
        };

        if (fallida && fallida.id) {
          await supabase.from('facturas').update(fila).eq('id', fallida.id);
        } else {
          await supabase.from('facturas').insert({ pedido_id: pedidoId, ...fila });
        }

        await log(pedidoId, 'factura_reintento_ok', f.numeroComprobante + ' CAE ' + f.cae);
        return ok({ success: true, numero: f.numeroComprobante, cae: f.cae });
      } catch (e) {
        // sigue fallando: dejamos registrado el nuevo error, no rompemos
        const msg = (e.message || String(e)).slice(0, 480);
        if (fallida && fallida.id) {
          await supabase.from('facturas').update({ error: msg }).eq('id', fallida.id);
        }
        await log(pedidoId, 'factura_reintento_error', msg);
        return ok({ success: false, error: msg });
      }
    } catch (e) {
      return bad(500, e.message || 'Error');
    }
  }

  return bad(405, 'Método no permitido');
};
