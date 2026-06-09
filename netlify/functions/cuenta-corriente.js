// netlify/functions/cuenta-corriente.js
// GET  /api/cuenta-corriente?token=...                 → resumen de saldos por cliente
// GET  /api/cuenta-corriente?email=X&token=...          → movimientos de un cliente
// POST /api/cuenta-corriente { accion, ..., token }
//   pago    { email, nombre?, monto, detalle? }   → registra un cobro (baja deuda)
//   cargo   { email, nombre?, monto, detalle? }   → suma deuda
//   ajuste  { email, nombre?, monto, detalle? }   → fija/ajusta saldo (saldo inicial)

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
    const email = (event.queryStringParameters || {}).email;
    try {
      if (email) {
        const { data } = await supabase.from('cuenta_corriente')
          .select('tipo, monto, detalle, comprobante_url, metodo, fecha').eq('cliente_email', email)
          .order('fecha', { ascending: false });
        let saldo = 0;
        (data || []).forEach(m => { saldo += Number(m.monto); });
        return ok({ success: true, email, saldo, movimientos: data || [] });
      }
      // Resumen por cliente
      const { data } = await supabase.from('cuenta_corriente')
        .select('cliente_email, cliente_nombre, monto');
      const mapa = {};
      (data || []).forEach(m => {
        const e = m.cliente_email;
        if (!mapa[e]) mapa[e] = { email: e, nombre: m.cliente_nombre || '', saldo: 0 };
        if (m.cliente_nombre && !mapa[e].nombre) mapa[e].nombre = m.cliente_nombre;
        mapa[e].saldo += Number(m.monto);
      });
      const clientes = Object.values(mapa).map(c => ({ ...c, saldo: Math.round(c.saldo * 100) / 100 }))
        .sort((a, b) => b.saldo - a.saldo);
      const deudaTotal = clientes.reduce((s, c) => s + (c.saldo > 0 ? c.saldo : 0), 0);
      return ok({ success: true, clientes, deudaTotal: Math.round(deudaTotal) });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }
  if (!autorizado(event, body)) return bad(401, 'No autorizado');

  const email = String(body.email || '').trim().toLowerCase();
  const monto = Number(body.monto);
  if (!email) return bad(400, 'Falta email del cliente');
  if (!monto || isNaN(monto)) return bad(400, 'Monto inválido');

  // pago = baja deuda (monto negativo); cargo = sube deuda (positivo); ajuste = lo que se indique
  let signo = 1, tipo = body.accion;
  if (body.accion === 'pago') signo = -1;
  else if (body.accion === 'cargo') signo = 1;
  else if (body.accion === 'ajuste') signo = 1;
  else return bad(400, 'Acción inválida');

  try {
    await supabase.from('cuenta_corriente').insert({
      cliente_email: email, cliente_nombre: String(body.nombre || ''),
      tipo, monto: signo * Math.abs(monto),
      detalle: String(body.detalle || (tipo === 'pago' ? 'Pago' : tipo === 'ajuste' ? 'Ajuste de saldo' : 'Cargo')),
      comprobante_url: String(body.comprobanteUrl || ''),
      metodo: String(body.metodo || '')
    });
    // saldo nuevo
    const { data } = await supabase.from('cuenta_corriente').select('monto').eq('cliente_email', email);
    const saldo = (data || []).reduce((s, m) => s + Number(m.monto), 0);
    return ok({ success: true, saldo: Math.round(saldo * 100) / 100 });
  } catch (err) {
    return bad(500, String(err));
  }
};
