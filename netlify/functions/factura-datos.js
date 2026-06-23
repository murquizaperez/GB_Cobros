// netlify/functions/factura-datos.js
// GET /api/factura-datos?pedidoId=123&token=...
//   Arma el payload COMPLETO de la factura de un pedido, listo para verFacturaC(d):
//   - emisor  : fijo, desde 'configuracion' (claves emisor_*)  → ver seed-emisor.sql
//   - receptor: desde el cliente del pedido (lectura tolerante de columnas)
//   - items   : desde detalle_pedidos (con precios reales)
//   - fiscales: CAE / número / fecha / vto, desde la tabla 'facturas' (tolerante)
//   Devuelve { success, datos, emitida }. Si todavía no hay CAE, emitida=false.
//
// No emite la factura: la emisión real (ARCA) ya ocurre en confirmar-pago.
// Este endpoint solo ENSAMBLA lo emitido para imprimirlo prolijo.

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const qs = event.queryStringParameters || {};
  const got = (event.headers['x-admin-token'] || qs.token || '').trim();
  return got === need;
}

// devuelve el primer campo con valor de una lista de nombres posibles
function pick(obj, names, def) {
  if (!obj) return def;
  for (const n of names) {
    if (obj[n] != null && obj[n] !== '') return obj[n];
  }
  return def;
}
function dig(s) { return String(s || '').replace(/\D/g, ''); }
function fechaISO(s) { return s ? String(s).slice(0, 10) : ''; }

const COND_VENTA = {
  efectivo: 'Contado', transferencia: 'Transferencia', tarjeta: 'Tarjeta',
  'mercado pago': 'Mercado Pago', mercadopago: 'Mercado Pago', regalo: 'Sin cargo'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event)) return bad(401, 'No autorizado');

  const qs = event.queryStringParameters || {};
  const pedidoId = parseInt(qs.pedidoId || qs.id || '0', 10);
  if (!pedidoId) return bad(400, 'Falta pedidoId');

  try {
    // ---------- pedido ----------
    const { data: pedido } = await supabase
      .from('pedidos').select('*').eq('id', pedidoId).single();
    if (!pedido) return bad(404, 'Pedido no encontrado');

    // ---------- items (con precios reales) ----------
    const { data: det } = await supabase
      .from('detalle_pedidos')
      .select('nombre, cantidad, precio_unitario, subtotal')
      .eq('pedido_id', pedidoId);
    const items = (det || []).map(d => {
      const cant = Number(d.cantidad) || 0;
      const pu = Number(d.precio_unitario) || 0;
      return {
        descripcion: d.nombre || '',
        cantidad: cant,
        unidadMedida: 'unidades',
        precioUnitario: pu,
        pctBonif: 0,
        impBonif: 0,
        subtotal: d.subtotal != null ? Number(d.subtotal) : cant * pu
      };
    });

    // ---------- emisor (fijo, desde configuracion) ----------
    const { data: cfg } = await supabase
      .from('configuracion').select('clave, valor').like('clave', 'emisor_%');
    const C = {};
    (cfg || []).forEach(r => { C[r.clave] = r.valor; });
    const emisor = {
      razonSocial: C.emisor_razon_social || 'Monnoserie',
      cuit: C.emisor_cuit || '',
      domicilio: C.emisor_domicilio || '',
      condicionIva: C.emisor_condicion_iva || 'Responsable Monotributo',
      iibb: C.emisor_iibb || '',
      inicioActividades: C.emisor_inicio_actividades || ''
    };
    const ptoVtaCfg = parseInt(C.emisor_punto_venta || '1', 10) || 1;

    // ---------- receptor (cliente) ----------
    let cli = null;
    if (pedido.cliente_id) {
      const { data } = await supabase
        .from('clientes').select('*').eq('id', pedido.cliente_id).single();
      cli = data || null;
    }
    const medio = String(pedido.medio_pago || '').toLowerCase().trim();
    const receptor = {
      razonSocial: pick(cli, ['razon_social', 'razonSocial', 'nombre', 'nombre_fantasia'], '') || '',
      cuit: pick(cli, ['cuit', 'cuit_cuil', 'documento', 'dni'], '') || pedido.factura_cuit || '',
      tipoDoc: 80, // 80 = CUIT
      condicionIva: pick(cli, ['condicion_iva', 'condicionIva'], 'Consumidor Final'),
      condicionVenta: COND_VENTA[medio] || (pedido.medio_pago || 'Contado'),
      domicilio: pick(cli, ['domicilio', 'direccion', 'address'], '')
    };

    // ---------- fiscales (factura emitida por ARCA) ----------
    // Tabla 'facturas': afip_numero, punto_venta, cae, cae_vto, importe, tipo, qr_url
    const { data: facs } = await supabase
      .from('facturas').select('*')
      .eq('pedido_id', pedidoId)
      .order('id', { ascending: false })
      .limit(5);
    // Elegimos la FACTURA (no una Nota de Crédito): preferimos la C con CAE.
    const lista = facs || [];
    const fac = lista.find(f => f.cae && f.tipo !== 'NC') || lista.find(f => f.tipo !== 'NC') || lista[0] || null;

    // Si la factura tiene snapshot congelado (emitidas desde la mejora), se devuelve
    // TAL CUAL se emitió — inmutable. El armado en vivo de abajo es solo fallback
    // para facturas viejas que no tienen snapshot.
    if (fac && fac.snapshot && fac.snapshot.cae) {
      return ok({ success: true, datos: fac.snapshot, emitida: true, fuente: 'snapshot' });
    }

    // punto de venta y número: ya se guardan por separado (numero/punto_venta);
    // si son viejas, afip_numero puede venir combinado "00001-00000468".
    let ptoVta = parseInt(pick(fac, ['punto_venta'], ptoVtaCfg), 10) || ptoVtaCfg;
    let numero = parseInt(pick(fac, ['numero'], 0), 10) || 0;
    if (!numero) {
      const numRaw = String(pick(fac, ['afip_numero', 'nro_comprobante'], ''));
      if (numRaw.includes('-')) {
        const p = numRaw.split('-');
        ptoVta = parseInt(p[0], 10) || ptoVta;
        numero = parseInt(p[1], 10) || 0;
      } else {
        numero = parseInt(numRaw, 10) || 0;
      }
    }

    // 'tipo' viene como letra ('C'); lo mapeamos al código de comprobante
    const TIPO_LETRA = { C: 11, c: 11, NC: 13 };
    const tipoComprobante = TIPO_LETRA[pick(fac, ['tipo'], 'C')] || 11;

    // fecha real del comprobante si está guardada; si no, cuándo se acreditó el pago
    const fechaEmision = fechaISO(
      pick(fac, ['fecha'], null) || pedido.pagado_en || pedido.fecha_pedido || new Date().toISOString()
    );

    const datos = {
      tipoComprobante,
      puntoVenta: ptoVta,
      numero,
      fechaEmision,
      periodoDesde: fechaEmision,
      periodoHasta: fechaEmision,
      vtoPago: fechaEmision,
      cae: String(pick(fac, ['cae'], '') || ''),
      vtoCae: fechaISO(pick(fac, ['cae_vto'], '')),
      qrUrl: pick(fac, ['qr_url'], '') || '',   // QR real de ARCA (si está, se usa tal cual)
      otrosTributos: 0,
      total: Number(pick(fac, ['importe'], pedido.total)) || Number(pedido.total) || 0,
      emisor,
      receptor,
      items
    };

    return ok({ success: true, datos, emitida: !!(fac && datos.cae) });
  } catch (e) {
    return bad(500, e.message || 'Error');
  }
};
