// netlify/functions/clima.js
// GET /api/clima?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&token=...
// Trae el clima diario de Mendoza (temp máx/mín, lluvia) desde Open-Meteo,
// que agrega datos de los servicios meteorológicos nacionales oficiales.
// Sin API key. Coordenadas de Mendoza capital.

const { ok, bad, preflight } = require('./_supabase');

const LAT = -32.8908, LON = -68.8272;

function autorizado(event) {
  const need = process.env.ADMIN_TOKEN;
  if (!need) return true;
  const got = (event.headers['x-admin-token'] || (event.queryStringParameters && event.queryStringParameters.token) || '').trim();
  return got === need;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();
  if (event.httpMethod !== 'GET') return bad(405, 'Método no permitido');
  if (!autorizado(event)) return bad(401, 'No autorizado');

  const q = event.queryStringParameters || {};
  const desde = q.desde, hasta = q.hasta;
  if (!desde || !hasta) return bad(400, 'Faltan fechas (desde, hasta)');

  // El archivo histórico de Open-Meteo tiene ~5 días de delay; para fechas
  // recientes usamos el forecast con past_days. Elegimos la fuente según la fecha.
  const hoy = new Date();
  const finReciente = (new Date(hasta) > new Date(hoy.getTime() - 6 * 86400000));

  try {
    let url;
    if (finReciente) {
      // forecast con past_days cubre los últimos ~92 días
      const diff = Math.min(92, Math.ceil((hoy - new Date(desde)) / 86400000) + 1);
      url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
        `&past_days=${diff}&forecast_days=1&timezone=America%2FArgentina%2FBuenos_Aires`;
    } else {
      url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}` +
        `&start_date=${desde}&end_date=${hasta}` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
        `&timezone=America%2FArgentina%2FBuenos_Aires`;
    }

    const r = await fetch(url);
    const data = await r.json();
    const d = data.daily || {};
    const dias = (d.time || []).map((fecha, i) => ({
      fecha,
      tmax: d.temperature_2m_max ? d.temperature_2m_max[i] : null,
      tmin: d.temperature_2m_min ? d.temperature_2m_min[i] : null,
      lluvia: d.precipitation_sum ? d.precipitation_sum[i] : 0,
      codigo: d.weathercode ? d.weathercode[i] : null
    })).filter(x => x.fecha >= desde && x.fecha <= hasta);

    return ok({ success: true, ciudad: 'Mendoza', fuente: 'Open-Meteo / SMN', dias });
  } catch (err) {
    return bad(500, 'No se pudo obtener el clima: ' + String(err));
  }
};
