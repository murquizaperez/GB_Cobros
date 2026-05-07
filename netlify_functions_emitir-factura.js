// =============================================
// GB Cobros v3.4 - Función Real ARCA (AFIP)
// =============================================

const Afip = require('afip-sdk');

exports.handler = async (event, context) => {
  // Solo permitir POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);

    // Validar datos mínimos
    if (!data.cuit || !data.puntoVenta || !data.tipoComprobante || !data.importeTotal) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Faltan datos obligatorios' })
      };
    }

    // Inicializar AFIP SDK con certificado del environment
    const afip = new Afip({
      CUIT: data.cuit,
      cert: process.env.AFIP_CERT,        // Certificado .pem (subido en Netlify)
      key: process.env.AFIP_KEY,          // Clave privada .pem
      production: true                    // true = ambiente de producción real
    });

    // Calcular valores
    const impNeto = Math.round(data.importeTotal / 1.21 * 100) / 100;
    const impIVA = Math.round((data.importeTotal - impNeto) * 100) / 100;

    // Crear el comprobante
    const response = await afip.ElectronicBilling.createVoucher({
      CantReg: 1,
      PtoVta: parseInt(data.puntoVenta),
      CbteTipo: parseInt(data.tipoComprobante), // 1 = A, 6 = B, 11 = C
      Concepto: 2,                              // 2 = Servicios (más común)
      DocTipo: data.cliente?.tipoDoc || 96,     // 96 = DNI, 80 = CUIT
      DocNro: data.cliente?.documento || 0,
      CbteFch: parseInt(new Date().toISOString().slice(0,10).replace(/-/g, '')),
      ImpTotal: data.importeTotal,
      ImpTotConc: 0,
      ImpNeto: impNeto,
      ImpIVA: impIVA,
      ImpTrib: 0,
      MonId: "PES",
      MonCotiz: 1,
      Iva: [
        {
          Id: 5,                    // 5 = IVA 21%
          BaseImp: impNeto,
          Importe: impIVA
        }
      ],
      items: data.items || [{
        Descripcion: data.concepto || "Servicio profesional",
        Cantidad: 1,
        PrecioUnitario: data.importeTotal,
        AlicuotaIVA: 21
      }]
    });

    // Respuesta exitosa
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        cae: response.CAE,
        numeroComprobante: `${data.puntoVenta.toString().padStart(4, '0')}-${response.CbteDesde.toString().padStart(8, '0')}`,
        fechaVencimiento: response.CAEFchVto,
        fechaEmision: new Date().toISOString().split('T')[0]
      })
    };

  } catch (error) {
    console.error('Error ARCA:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: false,
        error: error.message || 'Error al emitir factura en ARCA',
        details: error.toString()
      })
    };
  }
};
