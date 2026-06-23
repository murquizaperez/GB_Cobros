// netlify/functions/_arca.js
// Lógica ARCA (Factura C / Nota de Crédito C Monotributo, WSFEV1) + consulta de padrón
// (constancia de inscripción) como MÓDULO interno.
//
// Variables de entorno necesarias en Netlify (este proyecto):
//   AFIP_CERT, AFIP_KEY   (el mismo certificado de producción que ya usás)
//   ARCA_CUIT             (CUIT del emisor Monnoserie, solo dígitos)
//   ARCA_PUNTO_VENTA      (punto de venta web services, ej: 3)
//
// NOTA padrón: el certificado debe tener habilitado el WS "ws_sr_constancia_inscripcion"
// en AFIP (Administrador de Relaciones). Si no, getTaxpayerDetails da error de auth.

require('tls').DEFAULT_CIPHERS = 'DEFAULT@SECLEVEL=0';
const { Arca } = require('@arcasdk/core');

const pad = (n, l) => String(n == null ? '' : n).padStart(l, '0');

// CondicionIVAReceptorId de AFIP (para discriminar el receptor en la emisión)
const CONDICION_IVA_ID = {
  'IVA Responsable Inscripto': 1,
  'IVA Exento': 4,
  'Consumidor Final': 5,
  'Responsable Monotributo': 6,
};

function nuevaArca() {
  const cuit = parseInt((process.env.ARCA_CUIT || process.env.AFIP_CUIT || '').replace(/\D/g, ''), 10);
  const cert = (process.env.AFIP_CERT || '').replace(/\\n/g, '\n');
  const key = (process.env.AFIP_KEY || '').replace(/\\n/g, '\n');
  if (!cuit) throw new Error('ARCA_CUIT no configurado');
  if (!cert || !key) throw new Error('AFIP_CERT/AFIP_KEY no configurados');
  return new Arca({ cuit, cert, key, production: true, ticketPath: '/tmp', useHttpsAgent: true });
}

// Emisión genérica WSFEV1. cbteTipo: 11 = Factura C, 13 = Nota de Crédito C.
async function _emitir({ cbteTipo, importeTotal, docCliente, cbtesAsoc, condIvaReceptor }) {
  const ptoVta = parseInt(process.env.ARCA_PUNTO_VENTA || process.env.AFIP_PUNTO_VENTA || '3', 10);
  const importe = Math.round(parseFloat(importeTotal) * 100) / 100;
  if (!importe || importe <= 0) throw new Error('Importe inválido');

  const arca = nuevaArca();
  const eb = arca.electronicBillingService;

  const docC = (docCliente || '').replace(/\D/g, '');
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const hoy = new Date();
  const primerDia = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const ultimoDia = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
  const vto = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 15);

  const payload = {
    CantReg: 1, PtoVta: ptoVta, CbteTipo: cbteTipo, Concepto: 2,
    DocTipo: docC ? 80 : 99,
    DocNro: docC ? parseInt(docC, 10) : 0,
    CbteFch: fmt(hoy),
    ImpTotal: importe, ImpTotConc: 0, ImpNeto: importe, ImpOpEx: 0, ImpIVA: 0, ImpTrib: 0,
    MonId: 'PES', MonCotiz: 1,
    CondicionIVAReceptorId: condIvaReceptor || 5,   // 5 = Consumidor Final (default histórico)
    FchServDesde: fmt(primerDia), FchServHasta: fmt(ultimoDia), FchVtoPago: fmt(vto),
  };
  if (cbtesAsoc && cbtesAsoc.length) payload.CbtesAsoc = cbtesAsoc;

  const res = await eb.createNextVoucher(payload);

  const det0 = (res.response && res.response.FeDetResp && res.response.FeDetResp.FECAEDetResponse &&
                res.response.FeDetResp.FECAEDetResponse[0]) || {};
  const cae = det0.CAE || res.CAE || res.cae;
  const resultado = det0.Resultado ||
    (res.response && res.response.FeCabResp && res.response.FeCabResp.Resultado) || res.Resultado;
  if (!cae || resultado === 'R') throw new Error('ARCA no aprobó: ' + JSON.stringify(res).slice(0, 300));

  const nroAsignado = det0.CbteDesde || res.CbteDesde || res.cbteDesde || '';
  const numero = parseInt(nroAsignado, 10) || 0;
  const fechaISO = payload.CbteFch.slice(0, 4) + '-' + payload.CbteFch.slice(4, 6) + '-' + payload.CbteFch.slice(6, 8);

  const qrData = {
    ver: 1, fecha: fechaISO,
    cuit: parseInt((process.env.ARCA_CUIT || process.env.AFIP_CUIT || '').replace(/\D/g, ''), 10),
    ptoVta, tipoCmp: cbteTipo, nroCmp: numero,
    importe, moneda: 'PES', ctz: 1, tipoDocRec: payload.DocTipo, nroDocRec: payload.DocNro,
    tipoCodAut: 'E', codAut: parseInt(cae, 10),
  };
  const qrUrl = 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(qrData)).toString('base64');

  return {
    success: true, cae, cbteTipo,
    numero,
    numeroComprobante: pad(ptoVta, 4) + '-' + pad(nroAsignado, 8),
    fecha: fechaISO,
    cae_vto: det0.CAEFchVto || res.CAEFchVto || '',
    qrUrl,
    puntoVenta: pad(ptoVta, 4),
    puntoVentaNum: ptoVta,
  };
}

/** Factura C real en ARCA. p.condicionIvaReceptorId opcional (default 5 = Consumidor Final). */
async function emitirFacturaC(p) {
  return _emitir({ cbteTipo: 11, importeTotal: p.importeTotal, docCliente: p.docCliente, condIvaReceptor: p.condicionIvaReceptorId });
}

/** Nota de Crédito C asociada a una factura original (Tipo 11). */
async function emitirNotaCreditoC(p) {
  const orig = p.original || {};
  const ptoVtaOrig = parseInt(String(orig.puntoVenta).replace(/\D/g, ''), 10) || parseInt(process.env.ARCA_PUNTO_VENTA || process.env.AFIP_PUNTO_VENTA || '3', 10);
  const nroOrig = parseInt(orig.numero, 10) || 0;
  if (!nroOrig) throw new Error('Falta el número de la factura original');
  const cbtesAsoc = [{ Tipo: 11, PtoVta: ptoVtaOrig, Nro: nroOrig }];
  return _emitir({ cbteTipo: 13, importeTotal: p.importeTotal, docCliente: p.docCliente, cbtesAsoc, condIvaReceptor: p.condicionIvaReceptorId });
}

/**
 * Consulta el padrón de AFIP (constancia de inscripción) por CUIT.
 * @param {string|number} cuit
 * @returns {Promise<null|{cuit, razonSocial, domicilio, condicionIva, condicionIvaId, tipoPersona, estado}>}
 */
async function consultarPadron(cuit) {
  const dig = String(cuit || '').replace(/\D/g, '');
  if (dig.length !== 11) throw new Error('CUIT inválido (deben ser 11 dígitos)');

  const arca = nuevaArca();
  const d = await arca.registerInscriptionProofService.getTaxpayerDetails(parseInt(dig, 10));
  if (!d) return null;
  if (d.errorConstancia && d.errorConstancia.error) {
    throw new Error('AFIP: ' + d.errorConstancia.error);
  }

  const dg = d.datosGenerales || {};
  const razonSocial = (dg.razonSocial || [dg.apellido, dg.nombre].filter(Boolean).join(' ')).trim();

  // domicilio: AFIP puede traerlo en domicilioFiscal {direccion, localidad, descripcionProvincia}
  const dom = dg.domicilioFiscal || dg.domicilio || dg || {};
  const calle = dom.direccion || dom.domicilio || '';
  const domicilio = [calle, dom.localidad, dom.descripcionProvincia].filter(Boolean).join(', ');

  // condición IVA: monotributo / régimen general (con IVA = RI, exento, etc.)
  let condicionIva = 'Consumidor Final';
  if (d.datosMonotributo) {
    condicionIva = 'Responsable Monotributo';
  } else if (d.datosRegimenGeneral) {
    const imps = (d.datosRegimenGeneral.impuesto || [])
      .map(i => String(i.descripcionImpuesto || i.idImpuesto || ''));
    if (imps.some(x => /IVA/i.test(x) && /EXENTO/i.test(x))) condicionIva = 'IVA Exento';
    else if (imps.some(x => /IVA/i.test(x))) condicionIva = 'IVA Responsable Inscripto';
    else condicionIva = 'IVA Responsable Inscripto'; // régimen general → RI por defecto
  }

  return {
    cuit: String(d.idPersona || dig),
    razonSocial,
    domicilio,
    condicionIva,
    condicionIvaId: CONDICION_IVA_ID[condicionIva] || 5,
    tipoPersona: d.tipoPersona || dg.tipoPersona || '',
    estado: d.estadoClave || dg.estadoClave || ''
  };
}

module.exports = { emitirFacturaC, emitirNotaCreditoC, consultarPadron, CONDICION_IVA_ID };
