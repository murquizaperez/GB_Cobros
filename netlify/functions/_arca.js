// netlify/functions/_arca.js
// Lógica ARCA (Factura C Monotributo, WSFEV1) como MÓDULO interno.
// Adaptado de emitir-factura.js (que ya funciona en producción en GB_Cobros).
// La cadena lo llama directo en el mismo proceso — sin saltos HTTP entre proyectos.
//
// Variables de entorno necesarias en Netlify (este proyecto):
//   AFIP_CERT, AFIP_KEY   (el mismo certificado de producción que ya usás)
//   ARCA_CUIT             (CUIT del emisor Monnoserie, solo dígitos)
//   ARCA_PUNTO_VENTA      (punto de venta web services, ej: 3)

require('tls').DEFAULT_CIPHERS = 'DEFAULT@SECLEVEL=0';
const { Arca } = require('@arcasdk/core');

/**
 * Emite una Factura C real en ARCA.
 * @param {Object} p
 * @param {number} p.importeTotal
 * @param {string} p.concepto
 * @param {string} [p.docCliente]  CUIT/DNI del receptor (vacío = consumidor final)
 * @returns {Promise<{success, cae, numeroComprobante, cae_vto, qrUrl, puntoVenta}>}
 */
async function emitirFacturaC(p) {
  const cuit = parseInt((process.env.ARCA_CUIT || '').replace(/\D/g, ''), 10);
  const ptoVta = parseInt(process.env.ARCA_PUNTO_VENTA || '3', 10);
  const cert = (process.env.AFIP_CERT || '').replace(/\\n/g, '\n');
  const key = (process.env.AFIP_KEY || '').replace(/\\n/g, '\n');

  if (!cuit) throw new Error('ARCA_CUIT no configurado');
  if (!cert || !key) throw new Error('AFIP_CERT/AFIP_KEY no configurados');

  const importe = Math.round(parseFloat(p.importeTotal) * 100) / 100;
  if (!importe || importe <= 0) throw new Error('Importe inválido');

  const arca = new Arca({ cuit, cert, key, production: true, ticketPath: '/tmp', useHttpsAgent: true });
  const eb = arca.electronicBillingService;

  const docCliente = (p.docCliente || '').replace(/\D/g, '');
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const hoy = new Date();
  const primerDia = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const ultimoDia = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
  const vto = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 15);

  const payload = {
    CantReg: 1, PtoVta: ptoVta, CbteTipo: 11, Concepto: 2,
    DocTipo: docCliente ? 80 : 99,
    DocNro: docCliente ? parseInt(docCliente, 10) : 0,
    CbteFch: fmt(hoy),
    ImpTotal: importe, ImpTotConc: 0, ImpNeto: importe, ImpOpEx: 0, ImpIVA: 0, ImpTrib: 0,
    MonId: 'PES', MonCotiz: 1, CondicionIVAReceptorId: 5,
    FchServDesde: fmt(primerDia), FchServHasta: fmt(ultimoDia), FchVtoPago: fmt(vto),
  };

  const res = await eb.createNextVoucher(payload);

  const det0 = (res.response && res.response.FeDetResp && res.response.FeDetResp.FECAEDetResponse &&
                res.response.FeDetResp.FECAEDetResponse[0]) || {};
  const cae = det0.CAE || res.CAE || res.cae;
  const resultado = det0.Resultado ||
    (res.response && res.response.FeCabResp && res.response.FeCabResp.Resultado) || res.Resultado;
  if (!cae || resultado === 'R') throw new Error('ARCA no aprobó: ' + JSON.stringify(res).slice(0, 300));

  const nroAsignado = det0.CbteDesde || res.CbteDesde || res.cbteDesde || '';
  const qrData = {
    ver: 1,
    fecha: payload.CbteFch.slice(0, 4) + '-' + payload.CbteFch.slice(4, 6) + '-' + payload.CbteFch.slice(6, 8),
    cuit, ptoVta, tipoCmp: 11, nroCmp: parseInt(nroAsignado, 10) || 0,
    importe, moneda: 'PES', ctz: 1, tipoDocRec: payload.DocTipo, nroDocRec: payload.DocNro,
    tipoCodAut: 'E', codAut: parseInt(cae, 10),
  };
  const qrUrl = 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(qrData)).toString('base64');

  return {
    success: true,
    cae,
    numeroComprobante: String(ptoVta).padStart(4, '0') + '-' + String(nroAsignado).padStart(8, '0'),
    cae_vto: det0.CAEFchVto || res.CAEFchVto || '',
    qrUrl,
    puntoVenta: String(ptoVta).padStart(4, '0'),
  };
}

module.exports = { emitirFacturaC };
