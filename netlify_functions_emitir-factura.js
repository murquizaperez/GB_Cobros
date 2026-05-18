// =============================================
// GB Cobros v3.4 - Función Real ARCA (AFIP)
// =============================================

const Afip = require('afip-sdk');
const fs = require('fs');
const path = require('path');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);
    
    if (!data.cuit || !data.puntoVenta || !data.tipoComprobante || !data.importeTotal) {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Faltan datos obligatorios' }) };
    }

    // 1. Manejo Serverless: Escribimos los certificados en /tmp (único directorio con permisos de escritura)
    const certPath = '/tmp/afip_cert.crt';
    const keyPath = '/tmp/afip_key.key';
    fs.writeFileSync(certPath, process.env.AFIP_CERT);
    fs.writeFileSync(keyPath, process.env.AFIP_KEY);

    // 2. Instanciar AFIP indicando res_folder hacia /tmp para que pueda guardar el TA.xml (caché del token)
    const afip = new Afip({
      CUIT: data.cuit,
      cert: certPath,
      key: keyPath,
      res_folder: '/tmp/', // CRÍTICO para Netlify
      production: true
    });

    const puntoVenta = parseInt(data.puntoVenta);
    const tipoComprobante = parseInt(data.tipoComprobante);

    // 3. Obtener el número de la última factura emitida y sumarle 1 (CRÍTICO)
    const lastVoucher = await afip.ElectronicBilling.getLastVoucher(puntoVenta, tipoComprobante);
    const numeroFactura = lastVoucher + 1;

    const impNeto = Math.round(data.importeTotal / 1.21 * 100) / 100;
    const impIVA = Math.round((data.importeTotal - impNeto) * 100) / 100;
    const fechaHoy = new Date().toISOString().slice(0,10).replace(/-/g, '');

    // 4. Armar el payload completo con los campos obligatorios para Servicios
    const payload = {
      CantReg: 1,
      PtoVta: puntoVenta,
      CbteTipo: tipoComprobante,
      Concepto: 2,
      DocTipo: data.cliente?.tipoDoc || 99, // 99 es Consumidor Final si no hay doc
      DocNro: data.cliente?.documento || 0,
      CbteDesde: numeroFactura, // AHORA SÍ PASAMOS EL NÚMERO
      CbteHasta: numeroFactura, // AHORA SÍ PASAMOS EL NÚMERO
      CbteFch: parseInt(fechaHoy),
      FchServDesde: parseInt(fechaHoy), // OBLIGATORIO para Concepto 2
      FchServHasta: parseInt(fechaHoy), // OBLIGATORIO para Concepto 2
      FchVtoPago: parseInt(fechaHoy),   // OBLIGATORIO para Concepto 2
      ImpTotal: data.importeTotal,
      ImpTotConc: 0,
      ImpNeto: impNeto,
      ImpIVA: impIVA,
      ImpTrib: 0,
      MonId: "PES",
      MonCotiz: 1,
      Iva: [{ Id: 5, BaseImp: impNeto, Importe: impIVA }]
    };

    const response = await afip.ElectronicBilling.createVoucher(payload);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        cae: response.CAE,
        numeroComprobante: `${puntoVenta.toString().padStart(4, '0')}-${numeroFactura.toString().padStart(8, '0')}`,
        fechaVencimiento: response.CAEFchVto
      })
    };
  } catch (error) {
    console.error('Error ARCA/AFIP:', error);
    // Extraemos el mensaje real que devuelve AFIP en caso de rechazo
    const errorMessage = error.message || error.toString();
    
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, error: errorMessage })
    };
  }
};
