// =============================================
// GB Cobros v3.5 - ARCA directa (@arcasdk/core)
// Factura C - Monotributo (CbteTipo 11, sin IVA)
// =============================================
require('tls').DEFAULT_CIPHERS = 'DEFAULT@SECLEVEL=0';
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
// createNextVoucher maneja la numeración solo (último + 1)
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
      CbteFch:   fmt(hoy),
      ImpTotal:  impTotal,
      ImpTotConc: 0,
      ImpNeto:   impTotal,
      ImpOpEx:   0,
      ImpIVA:    0,
      ImpTrib:   0,
      MonId:     'PES',
      MonCotiz:  1,
      CondicionIVAReceptorId: 5,
      FchServDesde: fmt(primerDia),
      FchServHasta: fmt(ultimoDia),
      FchVtoPago:   fmt(vto),
    };

    console.log('[GB Cobros] Enviando a ARCA:', JSON.stringify(payload));

    const res = await eb.createNextVoucher(payload);

    console.log('[GB Cobros] Respuesta ARCA:', JSON.stringify(res));

const det0 = (res.response && res.response.FeDetResp &&
                  res.response.FeDetResp.FECAEDetResponse &&
                  res.response.FeDetResp.FECAEDetResponse[0]) || {};
    const cae = (det0.CAE) || res.CAE || res.cae;
    const resultado = (det0.Resultado) ||
                      (res.response && res.response.FeCabResp && res.response.FeCabResp.Resultado) ||
                      res.Resultado || res.resultado;
    if (!cae || resultado === 'R') {
      throw new Error('ARCA no aprobó. Respuesta: ' + JSON.stringify(res));
    }

  // El número real viene anidado en la respuesta de ARCA
    let nroAsignado = '';
    try {
      const det = res.response &&
                  res.response.FeDetResp &&
                  res.response.FeDetResp.FECAEDetResponse &&
                  res.response.FeDetResp.FECAEDetResponse[0];
      nroAsignado = (det && det.CbteDesde) ||
                    res.CbteDesde || res.cbteDesde || res.voucherNumber || '';
    } catch (_) {
      nroAsignado = res.CbteDesde || '';
    }
    // QR oficial ARCA (RG 4892)
    const nroCmpNum = parseInt(nroAsignado, 10) || 0;
    const qrData = {
      ver: 1,
      fecha: payload.CbteFch.slice(0,4) + '-' + payload.CbteFch.slice(4,6) + '-' + payload.CbteFch.slice(6,8),
      cuit: cuit,
      ptoVta: ptoVta,
      tipoCmp: cbteTipo,
      nroCmp: nroCmpNum,
      importe: impTotal,
      moneda: 'PES',
      ctz: 1,
      tipoDocRec: payload.DocTipo,
      nroDocRec: payload.DocNro,
      tipoCodAut: 'E',
      codAut: parseInt(cae, 10),
    };
    const qrUrl = 'https://www.afip.gob.ar/fe/qr/?p=' +
      Buffer.from(JSON.stringify(qrData)).toString('base64');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        cae: cae,
        numeroComprobante:
          String(ptoVta).padStart(4, '0') + '-' + String(nroAsignado).padStart(8, '0'),
      fechaVencimiento: det0.CAEFchVto || res.CAEFchVto || res.caeFchVto || '',
       resultado: resultado || 'A',
        tipoComprobante: 'C',
        qrUrl: qrUrl,
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
