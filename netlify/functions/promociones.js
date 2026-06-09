// netlify/functions/promociones.js
// ADMIN (con token):
//   GET  /api/promociones?token=...           → todas las promos (para gestionar)
//   POST /api/promociones { accion, ..., token }  crear | editar | borrar
// PÚBLICO (sin token, para el portal):
//   GET  /api/promociones?publico=1           → promos activas y vigentes ahora

const { supabase, ok, bad, preflight } = require('./_supabase');

function autorizado(event, body) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (body && body.token) ||
    (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}

// ¿la promo está vigente ahora? (fecha + franja horaria)
function vigente(p) {
  const hoy = new Date();
  const dia = hoy.toISOString().slice(0, 10);
  if (p.desde && dia < p.desde) return false;
  if (p.hasta && dia > p.hasta) return false;
  if (p.hora_desde != null || p.hora_hasta != null) {
    const h = (hoy.getUTCHours() - 3 + 24) % 24; // hora de Argentina aprox
    if (p.hora_desde != null && h < p.hora_desde) return false;
    if (p.hora_hasta != null && h >= p.hora_hasta) return false;
  }
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    try {
      if (q.publico) {
        // solo activas y vigentes, con nombre del producto
        const { data } = await supabase.from('promociones')
          .select('id, titulo, descripcion, tipo, producto_id, valor, hora_desde, hora_hasta, desde, hasta, activa, productos(nombre)')
          .eq('activa', true);
        const vig = (data || []).filter(vigente).map(p => ({
          id: p.id, titulo: p.titulo, descripcion: p.descripcion, tipo: p.tipo,
          productoId: p.producto_id, producto: p.productos ? p.productos.nombre : null, valor: Number(p.valor)
        }));
        return ok({ success: true, promociones: vig });
      }
      if (!autorizado(event, null)) return bad(401, 'No autorizado');
      const { data } = await supabase.from('promociones')
        .select('*, productos(nombre)').order('creado_en', { ascending: false });
      return ok({ success: true, promociones: (data || []).map(p => ({
        ...p, producto: p.productos ? p.productos.nombre : null
      })) });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  try {
    const accion = body.accion;
    if (accion === 'crear') {
      if (!body.titulo) return bad(400, 'Falta título');
      const { error } = await supabase.from('promociones').insert({
        titulo: String(body.titulo).trim(), descripcion: String(body.descripcion || ''),
        tipo: ['descuento', 'precio', 'destacado'].includes(body.tipo) ? body.tipo : 'destacado',
        producto_id: body.productoId ? parseInt(body.productoId, 10) : null,
        valor: Number(body.valor) || 0,
        desde: body.desde || null, hasta: body.hasta || null,
        hora_desde: body.horaDesde != null && body.horaDesde !== '' ? parseInt(body.horaDesde, 10) : null,
        hora_hasta: body.horaHasta != null && body.horaHasta !== '' ? parseInt(body.horaHasta, 10) : null
      });
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }
    const id = parseInt(body.id, 10);
    if (!id) return bad(400, 'Falta id');
    if (accion === 'borrar') {
      const { error } = await supabase.from('promociones').delete().eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }
    if (accion === 'toggle') {
      const { error } = await supabase.from('promociones').update({ activa: !!body.activa }).eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ success: true });
    }
    return bad(400, 'Acción inválida');
  } catch (err) {
    return bad(500, String(err));
  }
};
