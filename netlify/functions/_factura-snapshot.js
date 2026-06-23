// netlify/functions/_factura-snapshot.js
// Arma el "congelado" de una factura en el momento de emitirla: emisor, receptor,
// ítems con sus precios de ESE momento, totales y datos fiscales (CAE/QR).
// Se guarda en facturas.snapshot (jsonb) y es lo que después se imprime,
// para que un comprobante reimpreso salga SIEMPRE idéntico al emitido.
//
// `fiscales` = { puntoVenta, afipNumero, cae, caeVto, qrUrl, importe } (lo que devuelve ARCA)

const COND_VENTA = {
  efectivo: 'Contado', transferencia: 'Transferencia', tarjeta: 'Tarjeta',
  'mercado pago': 'Mercado Pago', mercadopago: 'Mercado Pago', regalo: 'Sin cargo'
};

function pick(obj, names, def) {
  if (!obj) return def;
  for (const n of names) if (obj[n] != null && obj[n] !== '') return obj[n];
  return def;
}
function fechaISO(s) { return s ? String(s).slice(0, 10) : ''; }

async function construirSnapshot(supabase, pedidoId, fiscales) {
  fiscales = fiscales || {};

  const { data: pedido } = await supabase
    .from('pedidos')
    .select('id, total, factura_cuit, cliente_id, medio_pago, pagado_en, fecha_pedido')
    .eq('id', pedidoId)
    .maybeSingle();

  // ítems con precios del momento
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

  // emisor fijo (config) — se congela también, por si cambia después
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

  // receptor
  let cli = null;
  if (pedido && pedido.cliente_id) {
    const { data } = await supabase.from('clientes').select('*').eq('id', pedido.cliente_id).maybeSingle();
    cli = data || null;
  }
  const medio = String((pedido && pedido.medio_pago) || '').toLowerCase().trim();
  const receptor = {
    razonSocial: pick(cli, ['razon_social', 'razonSocial', 'nombre', 'nombre_fantasia'], '') || '',
    cuit: pick(cli, ['cuit', 'cuit_cuil', 'documento', 'dni'], '') || (pedido && pedido.factura_cuit) || '',
    tipoDoc: 80,
    condicionIva: pick(cli, ['condicion_iva', 'condicionIva'], 'Consumidor Final'),
    condicionVenta: COND_VENTA[medio] || ((pedido && pedido.medio_pago) || 'Contado'),
    domicilio: pick(cli, ['domicilio', 'direccion', 'address'], '')
  };

  // número y punto de venta
  let ptoVta = Number(fiscales.puntoVenta) || ptoVtaCfg;
  let numero = 0;
  const numRaw = String(fiscales.afipNumero || '');
  if (numRaw.includes('-')) {
    const p = numRaw.split('-');
    ptoVta = parseInt(p[0], 10) || ptoVta;
    numero = parseInt(p[1], 10) || 0;
  } else {
    numero = parseInt(numRaw, 10) || 0;
  }

  const fechaEmision = fechaISO(fiscales.fecha || (pedido && pedido.pagado_en) || new Date().toISOString());
  const total = Number(fiscales.importe != null ? fiscales.importe : (pedido && pedido.total)) || 0;

  return {
    tipoComprobante: Number(fiscales.tipoComprobante) || 11,   // 11 = Factura C · 13 = Nota de Crédito C
    puntoVenta: ptoVta,
    numero,
    fechaEmision,
    periodoDesde: fechaEmision,
    periodoHasta: fechaEmision,
    vtoPago: fechaEmision,
    cae: String(fiscales.cae || ''),
    vtoCae: fechaISO(fiscales.caeVto || ''),
    qrUrl: fiscales.qrUrl || '',
    otrosTributos: 0,
    total,
    emisor,
    receptor,
    items
  };
}

module.exports = { construirSnapshot };
