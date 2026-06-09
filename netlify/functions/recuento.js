// netlify/functions/recuento.js
// POST /api/recuento  { items:[{ingredienteId, stockReal}], responsable?, token }
//   Para cada ingrediente: compara el stock real contado con el del sistema,
//   registra la diferencia (merma), y ajusta el stock al valor real.
// GET /api/recuento?token=...  → últimos recuentos con su merma valorizada

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

  // Historial / último análisis
  if (event.httpMethod === 'GET') {
    if (!autorizado(event, null)) return bad(401, 'No autorizado');
    try {
      const { data } = await supabase
        .from('recuentos')
        .select('stock_sistema, stock_real, diferencia, valor_diferencia, responsable, fecha, ingredientes(nombre, unidad)')
        .order('fecha', { ascending: false }).limit(60);
      return ok({ success: true, recuentos: (data || []).map(r => ({
        ingrediente: r.ingredientes ? r.ingredientes.nombre : '',
        unidad: r.ingredientes ? r.ingredientes.unidad : '',
        sistema: Number(r.stock_sistema), real: Number(r.stock_real),
        diferencia: Number(r.diferencia), valorDiferencia: Number(r.valor_diferencia),
        responsable: r.responsable, fecha: r.fecha
      })) });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return bad(400, 'Sin ingredientes para contar');
  const responsable = String(body.responsable || '');

  try {
    const ids = items.map(i => parseInt(i.ingredienteId, 10)).filter(Boolean);
    const { data: ings } = await supabase.from('ingredientes')
      .select('id, nombre, unidad, stock_actual, costo_unitario').in('id', ids);
    const mapa = {};
    (ings || []).forEach(i => { mapa[i.id] = i; });

    const fecha = new Date().toISOString();
    const detalle = [];
    let mermaTotalValor = 0, conMerma = 0;
    const filasRecuento = [];

    for (const it of items) {
      const id = parseInt(it.ingredienteId, 10);
      const ing = mapa[id];
      if (!ing) continue;
      const sistema = Number(ing.stock_actual) || 0;
      const real = Number(it.stockReal);
      if (isNaN(real)) continue;
      const diff = Math.round((real - sistema) * 1000) / 1000;
      const valorDiff = Math.round(diff * (Number(ing.costo_unitario) || 0) * 100) / 100;
      if (diff !== 0) { conMerma++; if (valorDiff < 0) mermaTotalValor += valorDiff; }

      filasRecuento.push({
        ingrediente_id: id, stock_sistema: sistema, stock_real: real,
        diferencia: diff, valor_diferencia: valorDiff, responsable, fecha
      });
      // Ajustar stock al valor real
      await supabase.from('ingredientes').update({ stock_actual: real, actualizado_en: fecha }).eq('id', id);

      detalle.push({ ingrediente: ing.nombre, unidad: ing.unidad, sistema, real, diferencia: diff, valorDiferencia: valorDiff });
    }

    if (filasRecuento.length) await supabase.from('recuentos').insert(filasRecuento);

    // Ordenar el detalle: las mermas más grandes (en valor) primero
    detalle.sort((a, b) => a.valorDiferencia - b.valorDiferencia);

    return ok({
      success: true,
      contados: filasRecuento.length, conDiferencia: conMerma,
      mermaTotalValor: Math.round(mermaTotalValor * 100) / 100,
      detalle
    });
  } catch (err) {
    return bad(500, String(err));
  }
};
