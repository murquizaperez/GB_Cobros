// ============================================================
// AGREGAR ESTO AL Code.gs (al final, antes de gbcobros_testPing)
// ============================================================

// ── Acción nueva: registrar factura desde Netlify ───────────
// Permite que la Netlify Function (o cualquier servicio) deje
// la factura en facturas_gb después de obtener el CAE de ARCA.
function gbcobros_registrarFacturaExterna(data) {
  // Espera el formato unificado de respuesta de emitir-factura.js
  var factura = {
    id:          data.id || Utilities.getUuid(),
    work_id:     data.work_id || '',
    afip_number: data.afip_number || data.numeroComprobante || data.numero || '',
    date:        data.date || new Date().toISOString().slice(0,10),
    amount:      Number(data.amount || data.importe || 0),
    notes:       data.notes || data.concepto || '',
    photo:       '',
    cae:         data.cae || '',
    cae_vto:     data.cae_vto || data.fechaVencimiento || '',
    tipo:        data.tipo || 'C',
    punto_venta: data.punto_venta || data.puntoVenta || '',
    qr_url:      data.qr_url || data.qrUrl || '',
    qr_img:      data.qr_img || '',
    created_at:  new Date().toISOString().slice(0,10)
  };
  return gbcobros_create('facturas_gb', factura);
}

// ============================================================
// REEMPLAZAR el switch del doPost para incluir la acción nueva
// ============================================================
// En el switch dentro de doPost(), agregar este case:
//
//     case 'registrar_factura_externa':
//       return gbcobros_cors(gbcobros_registrarFacturaExterna(data));
//
// Queda así el switch completo:
/*
    switch (action) {
      case 'ping':                       return gbcobros_cors({ ok: true, ts: new Date().toISOString() });
      case 'list':                       return gbcobros_cors(gbcobros_list(table));
      case 'get':                        return gbcobros_cors(gbcobros_get(table, id));
      case 'create':                     return gbcobros_cors(gbcobros_create(table, data));
      case 'update':                     return gbcobros_cors(gbcobros_update(table, data));
      case 'remove':                     return gbcobros_cors(gbcobros_remove(table, id));
      case 'bulk_upsert':                return gbcobros_cors(gbcobros_bulkUpsert(table, body.rows || []));
      case 'registrar_factura_externa':  return gbcobros_cors(gbcobros_registrarFacturaExterna(data));
      default:                           return gbcobros_cors({ error: 'Acción desconocida: ' + action });
    }
*/
