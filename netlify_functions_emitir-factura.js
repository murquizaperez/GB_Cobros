// =============================================
// GB Cobros v3.5 - ARCA directa (@arcasdk/core)
// Factura C - Monotributo (CbteTipo 11, sin IVA)
// =============================================
const {
  Arca,
  AuthRepository,
  AccessTicket,
  ServiceNamesEnum,
} = require('@arcasdk/core');
const fs = require('fs');

// El TA (Ticket de Acceso) de ARCA dura 12hs y ARCA limita los logins.
// En serverless lo cacheamos en /tmp para reusarlo entre invocaciones.
const TA_PATH = '/tmp/TA-arca-wsfe.json';

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

    // ── PEM: Netlify aplana los \n a literales ──────────────────
    const cert = (process.env.AFIP_CERT || '').replace(/\\n/g, '\n');
    const key  = (process.env.AFIP_KEY  || '').replace(/\\n/g, '\n');
    if (!cert || !key) throw new Error('AFIP_CERT o AFIP_KEY no configuradas');

    const cuit = parseInt(data.cuit, 10);

    // ── Obtener / reusar el Ticket de Acceso (WSAA) ─────────────
    let ticket = null;
    try {
      if (fs.existsSync(TA_PATH)) {
        const saved = JSON.parse(fs.readFileSync(TA_PATH, 'utf8'));
        const t = AccessTicket.create(saved);
        if (!t.isExpired()) ticket = t;
      }
    } catch (_) { /* TA corrupto → login nuevo */ }

    if (!ticket) {
      const authRepo = new AuthRepository({
        cert, key, cuit,
        production: true,
        handleTicket: false,
        useHttpsAgent: true, // ARCA usa SSL legacy; en Node hace falta
      });
      ticket = await authRepo.login(ServiceNamesEnum.WSFE);
      try {
        fs.writeFileSync(TA_PATH, JSON.stringify(ticket.toLoginCredentials()), 'utf8');
      } catch (_) { /* /tmp no escribible: seguimos igual */ }
    }

    // ── Instancia Arca con el TA ya resuelto ────────────────────
    const arca = new Arca({
      cert, key, cuit,
      production: true,
      handleTicket: true,
      credentials: ticket.toLoginCredentials(),
      useHttpsAgent: true,
    });

    const ptoVta   = parseInt(data.puntoVenta, 10);
    const cbteTipo = 11; // Factura C - Monotributo (FIJO)

    // ── Último comprobante autorizado (evita error 10016) ───────
    const last = await arca.electronicBillingService.getLastVoucher(ptoVta, cbteTipo);
    const nro  = last + 1;

    // ── Factura C: SIN desglose de IVA ──────────────────────────
    const impTotal = Math.round(parseFloat(data.importeTotal) * 100) / 100;

    // ── Fechas en formato string YYYYMMDD ───────────────────────
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const hoy = new Date();
    const primerDia = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const ultimoDia = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
    const vto       = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 15);

    const voucher = {
      CantReg:   1,
      PtoVta:    ptoVta,
      CbteTipo:  cbteTipo,                         // 11 = Factura C
      Concepto:  2,                                // Servicios
      DocTipo:   data.cliente?.documento ? 80 : 99, // 99 = Consumidor Final
      DocNro:    parseInt(data.cliente?.documento ?? 0, 10),
      CbteDesde: nro,
      CbteHasta: nro,
      CbteFch:   fmt(hoy),
      ImpTotal:  impTotal,
      ImpTotConc: 0,
      ImpNeto:   impTotal,                         // el total va como neto
      ImpOpEx:   0,
      ImpIVA:    0,                                // SIN IVA en Factura C
      ImpTrib:   0,
      MonId:     'PES',
      MonCotiz:  1,
      FchServDesde: fmt(primerDia),                // obligatorio Concepto 2
      FchServHasta: fmt(ultimoDia),                // obligatorio Concepto 2
      FchVtoPago:   fmt(vto),                      // obligatorio Concepto 2
      // SIN array Iva: en Factura C no se envía
    };

    console.log('[GB Cobros] Enviando a ARCA:', JSON.stringify(voucher));
    const res = await arca.electronicBillingService.createVoucher(voucher);
    console.log('[GB Cobros] Respuesta ARCA:', JSON.stringify(res));

    // ── Validación real (Resultado debe ser "A") ────────────────
    if (!res || !res.CAE || res.Resultado !== 'A') {
      throw new Error(
        `ARCA no aprobó. Resultado: ${res?.Resultado ?? 'desconocido'}. ` +
        `Respuesta: ${JSON.stringify(res)}`
      );
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        cae: res.CAE,
        numeroComprobante: `${String(ptoVta).padStart(4, '0')}-${String(nro).padStart(8, '0')}`,
        fechaVencimiento: res.CAEFchVto,
        resultado: res.Resultado,
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
