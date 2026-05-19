// =============================================
// GB Cobros v3.5 - ARCA directa (@arcasdk/core)
// Factura C - Monotributo (CbteTipo 11, sin IVA)
// =============================================
const { Arca } = require('@arcasdk/core');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);

    if (!data.cuit || !data.puntoVenta || !data.importeTotal) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Faltan datos obligatorios' }),
      };
    }

    const cert = (process.env.AFIP_CERT || '').replace(/\\n/g, '\n');
    const key  = (process.env.AFIP_KEY  || '').replace(/\\n/g, '\n');
    if (!cert || !key) throw new Error('AFIP_CERT o AFIP_KEY no configuradas en Netlify');

    const cuit = parseInt(data.cuit, 10);

    // Instancia simple: la librería maneja WSAA por dentro
    const arca = new Arca({
      cuit,
      cert,
      key,
      production: true,
      ticketPath: '/tmp',     // FIX: en Netlify solo /tmp es escribible
      useHttpsAgent: true,    // ARCA usa SSL legacy; en Node.js hace falta
    });

    const eb = arca.electronicBillingService;

    // Log de diagnóstico: muestra los métodos reales disponibles
    try {
      const proto = Object.getPrototypeOf(eb);
      console.log('[GB Cobros] Metodos EB:', Object.getOwnPropertyNames(proto).join(', '));
    } catch (_) {}

    const ptoVta   = parseInt(data.puntoVenta, 10);
    const cbteTipo = 11; // Factura C - Monotributo

    // Último número autorizado (probamos los nombres posibles del método)
    let last = 0;
    if (typeof eb.getLastBillNumber === 'function') {
      last = await eb.getLastBillNumber(ptoVta, cbteTipo);
    } else if (typeof eb.getLastVoucher === 'function') {
      last = await eb.getLastVoucher(ptoVta, cbteTipo);
    } else {
      throw new Error('No se encontró método para obtener el último comprobante. Revisar log "Metodos EB".');
    }
    const nro = (typeof last === 'object' && last !== null && last.CbteNro != null)
      ? parseInt(last.CbteNro, 10) + 1
      : parseInt(last, 10) + 1;

    const impTotal = Math.round(parseFloat(data.importeTotal) * 100) / 100;

    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const hoy = new Date();
    const primerDia = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const ultimoDia = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
    const vto       = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 15);

    const payload = {
      CantReg:   1,
      PtoVta:    ptoVta,
      CbteTipo:  cbteTipo,
      Concepto:  2,
      DocTipo:   data.cliente && data.cliente.documento ? 80 : 99,
      DocNro:    parseInt((data.cliente && data.cliente.documento) || 0, 10),
      CbteDesde: nro,
      CbteHasta: nro,
      CbteFch:   fmt(hoy),
      ImpTotal:  impTotal,
      ImpTotConc: 0,
      ImpNeto:   impTotal,
      ImpOpEx:   0,
      ImpIVA:    0,
      ImpTrib:   0,
      MonId:     'PES',
      MonCotiz:  1,
      CondicionIVAReceptorId: 5, // 5 = Consumidor Final
      FchServDesde: fmt(primerDia),
      FchServHasta: fmt(ultimoDia),
      FchVtoPago:   fmt(vto),
    };

    console.log('[GB Cobros] Enviando a ARCA:', JSON.stringify(payload));

    let res;
    if (typeof eb.createVoucher === 'function') {
      res = await eb.createVoucher(payload);
    } else if (typeof eb.createInvoice === 'function') {
      res = await eb.createInvoice(payload);
    } else {
      throw new Error('No se encontró método para crear comprobante. Revisar log "Metodos EB".');
    }

    console.log('[GB Cobros] Respuesta ARCA:', JSON.stringify(res));

    const cae = res && (res.CAE || res.cae);
    const resultado = res && (res.Resultado || res.resultado);
    if (!cae || resultado === 'R') {
      throw new Error('ARCA no aprobó. Respuesta: ' + JSON.stringify(res));
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        cae: cae,
        numeroComprobante:
          String(ptoVta).padStart(4, '0') + '-' + String(nro).padStart(8, '0'),
        fechaVencimiento: res.CAEFchVto || res.caeFchVto || '',
        resultado: resultado || 'A',
        tipoComprobante: 'C',
      }),
    };

  } catch (error) {
    console.error('[GB Cobros] Error ARCA:', error.message, error.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, error: error.message || 'Error al emitir' }),
    };
  }
};
