// netlify/functions/registrar-cliente.js
// POST /api/registrar-cliente
// Body: { nombre, telefono, email, dniCuit, direccion, tipo }
// Crea el cliente si no existe (por teléfono). Si existe, lo devuelve.
// Idempotente: llamarlo dos veces con el mismo teléfono no duplica.

const { supabase, ok, bad, preflight } = require('./_supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }

  const nombre = String(body.nombre || '').trim();
  const telefono = String(body.telefono || '').trim();
  if (!nombre || !telefono) return bad(400, 'Nombre y teléfono son obligatorios');

  const tipo = ['minorista', 'mayorista', 'ambos'].includes(body.tipo) ? body.tipo : 'minorista';

  try {
    // ¿Ya existe?
    const { data: existente, error: errBusq } = await supabase
      .from('clientes')
      .select('id, nombre, telefono, tipo')
      .eq('telefono', telefono)
      .maybeSingle();

    if (errBusq) return bad(500, errBusq.message);
    if (existente) {
      return ok({ success: true, yaExistia: true, cliente: existente });
    }

    // Alta
    const { data: nuevo, error: errAlta } = await supabase
      .from('clientes')
      .insert({
        nombre,
        telefono,
        email: String(body.email || '').trim(),
        dni_cuit: String(body.dniCuit || '').trim(),
        direccion: String(body.direccion || '').trim(),
        tipo
      })
      .select('id, nombre, telefono, tipo')
      .single();

    if (errAlta) return bad(500, errAlta.message);
    return ok({ success: true, yaExistia: false, cliente: nuevo });
  } catch (err) {
    return bad(500, String(err));
  }
};
