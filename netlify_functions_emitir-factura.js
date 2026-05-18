// =============================================
// GB Cobros v3.4 - Función Real ARCA (AFIP)
// =============================================
const Afip = require('afip-sdk');
const fs   = require('fs');

exports.handler = async (event, context) => {

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin':  '*',
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

    // ── Validación de campos obligatorios ──────────────────────────
    if (!data.cuit || !data.puntoVenta || !data.tipoComprobante || !data.importeTotal) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Faltan datos obligatorios' }),
      };
    }

    // ── FIX 1: Reconstruir PEM — Netlify aplana los \n ─────────────
    const certRaw = process.env.AFIP_CERT;
    const keyRaw  = process.env.AFIP_KEY;

    if (!certRaw || !keyRaw) {
      throw new Error('AFIP_CERT o AFIP_KEY no están configuradas en Netlify');
    }

    const certPEM = certRaw.replace(/\\n/g, '\n');
    const keyPEM  = keyRaw.replace(/\\n/g, '\n');

    // ── FIX 2: Escribir cert/key en /tmp (único dir escribible) ────
    fs.writeFileSync('/tmp/afip_cert.pem', certPEM, 'utf8');
    fs.writeFileSync('/tmp/afip_key.pem',  keyPEM,  'utf8');

    // ── FIX 3: res_folder en /tmp para el Ticket de Acceso ─────────
    const afip = new Afip({
      CUIT:       parseInt(data.cuit, 10),
      cert:       '/tmp/afip_cert.pem',
      key:        '/tmp/afip_key.pem',
      production: true,
      res_folder: '/tmp',
    });

    // ── FIX 4: Aritmética IVA sin errores de punto flotante ─────────
    const impTotal = Math.round(parseFloat(data.importeTotal) * 100) / 100;
    const impNeto  = Math.round((impTotal / 1.21) * 100) / 100;
    const impIVA   = Math.round((impTotal - impNeto) * 100) / 100;

    // AFIP rechaza si la suma no cierra exacta al centavo
    const sumaCheck = Math.round((impNeto + impIVA) * 100) / 100;
    if (sumaCheck !== impTotal) {
      throw new Error(
        `Error aritmético IVA: ${impNeto} + ${impIVA} = ${sumaCheck}, esperado ${impTotal}`
      );
    }

    // ── Helpers de fecha ────────────────────────────────────────────
    const toAfipDate = (d) =>
      parseInt(d.toISOString().slice(0, 10).replace(/-/g, ''), 10);

    const hoy         = new Date();
    const primerDia   = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const ultimoDia   = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
    const vencimiento = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 15);

    // ── FIX 5: Campos obligatorios para Concepto 2 (Servicios) ─────
    // ── FIX 6: Eliminar "items" — no existe en WSFEV1 ───────────────
    const voucherData = {
      CantReg:      1,
      PtoVta:       parseInt(data.puntoVenta, 10),
      CbteTipo:     parseInt(data.tipoComprobante, 10),
      Concepto:     2,
      DocTipo:      data.cliente?.tipoDoc  ?? 96,
      DocNro:       parseInt(data.cliente?.documento ?? 0, 10),
      CbteFch:      toAfipDate(hoy),
      ImpTotal:     impTotal,
      ImpTotConc:   0,
      ImpNeto:      impNeto,
      ImpOpEx:      0,
      ImpIVA:       impIVA,
      ImpTrib:      0,
      MonId:        'PES',
      MonCotiz:     1,
      FchServDesde: toAfipDate(primerDia),   // ← obligatorio Concepto 2
      FchServHasta: toAfipDate(ultimoDia),   // ← obligatorio Concepto 2
      FchVtoPago:   toAfipDate(vencimiento), // ← obligatorio Concepto 2
      Iva: [{ Id: 5, BaseImp: impNeto, Importe: impIVA }],
    };

    console.log('[GB Cobros] Enviando a AFIP:', JSON.stringify(voucherData, null, 2));

    const response = await afip.ElectronicBilling.createVoucher(voucherData);

    console.log('[GB Cobros] Respuesta AFIP:', JSON.stringify(response, null, 2));

    // ── FIX 7: Validar que AFIP realmente aprobó ───────────────────
    if (!response || !response.CAE) {
      const obs = response?.Observaciones?.Obs
        ? JSON.stringify(response.Observaciones.Obs)
        : 'Sin detalle de AFIP';
      throw new Error(`AFIP rechazó el comprobante. Observaciones: ${obs}`);
    }

    const nroComprobante =
      `${String(data.puntoVenta).padStart(4, '0')}-` +
      `${String(response.CbteDesde).padStart(8, '0')}`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success:           true,
        cae:               response.CAE,
        numeroComprobante: nroComprobante,
        fechaVencimiento:  response.CAEFchVto,
        cbteDesde:         response.CbteDesde,
        resultado:         response.Resultado ?? 'A',
      }),
    };

  } catch (error) {
    console.error('[GB Cobros] Error ARCA:', error.message);
    console.error('[GB Cobros] Stack:',      error.stack);

    return {
      statusCode: 500,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        success: false,
        error:   error.message || 'Error al emitir factura en ARCA',
      }),
    };
  }
};
