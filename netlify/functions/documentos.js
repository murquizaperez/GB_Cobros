// netlify/functions/documentos.js
// GET  /api/documentos?token=...            → lista de documentos (monitoreo)
// GET  /api/documentos?id=N&token=...        → un documento con sus ítems
// POST /api/documentos { accion, ..., token }
//   guardar  { doc:{...}, items:[...] }      → crea el documento + ítems
//   revisar  { id, estado }                  → marca revisado
//   borrar   { id }

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (body && body.token) ||
    (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    const id = parseInt((event.queryStringParameters || {}).id, 10);
    try {
      if (id) {
        const { data: doc } = await supabase.from('documentos').select('*').eq('id', id).maybeSingle();
        const { data: items } = await supabase.from('documento_items').select('*').eq('documento_id', id);
        return ok({ success: true, documento: doc, items: items || [] });
      }
      const { data } = await supabase.from('documentos')
        .select('id, tipo, origen, emisor, cuit, numero, fecha, importe_total, cae, metodo, estado, archivo_url, creado_en')
        .order('creado_en', { ascending: false }).limit(200);
      return ok({ success: true, documentos: data || [] });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  try {
    if (body.accion === 'guardar') {
      const d = body.doc || {};
      const { data: doc, error } = await supabase.from('documentos').insert({
        tipo: d.tipo || 'comprobante', origen: d.origen || '', archivo_url: d.archivoUrl || '',
        emisor: d.emisor || '', cuit: d.cuit || '', numero: d.numero || '',
        fecha: d.fecha || null, importe_total: Number(d.importeTotal) || 0,
        cae: d.cae || '', metodo: d.metodo || '', cliente_email: d.clienteEmail || '',
        datos_qr: d.datosQr || null, texto_ocr: (d.textoOcr || '').slice(0, 4000)
      }).select('id').maybeSingle();
      if (error) return bad(500, error.message);

      const items = Array.isArray(body.items) ? body.items : [];
      if (doc && doc.id && items.length) {
        await supabase.from('documento_items').insert(items.map(it => ({
          documento_id: doc.id, descripcion: String(it.descripcion || ''),
          cantidad: Number(it.cantidad) || 1, precio_unitario: Number(it.precioUnitario) || 0,
          subtotal: Number(it.subtotal) || 0
        })));
      }
      return ok({ success: true, id: doc && doc.id });
    }

    const id = parseInt(body.id, 10);
    if (!id) return bad(400, 'Falta id');
    if (body.accion === 'revisar') {
      await supabase.from('documentos').update({ estado: body.estado || 'revisado' }).eq('id', id);
      return ok({ success: true });
    }
    if (body.accion === 'borrar') {
      await supabase.from('documentos').delete().eq('id', id);
      return ok({ success: true });
    }
    return bad(400, 'Acción inválida');
  } catch (err) {
    return bad(500, String(err));
  }
};
