// netlify/functions/portal-mayorista.js
// Portal del cliente mayorista (no usa ADMIN_TOKEN; se autentica con código de acceso).
// GET  /api/portal-mayorista?codigo=XXX           → valida cliente, devuelve su catálogo con precios
// POST /api/portal-mayorista  { codigo, items:[{productoId, cantidad}], nota? } → crea pedido mayorista

const { supabase, ok, bad, preflight } = require('./_supabase');

async function clientePorCodigo(codigo) {
  const { data } = await supabase.from('clientes_mayoristas')
    .select('id, nombre, codigo_acceso, activo').eq('codigo_acceso', codigo).eq('activo', true).maybeSingle();
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  if (event.httpMethod === 'GET') {
    const codigo = String((event.queryStringParameters || {}).codigo || '').trim();
    if (!codigo) return bad(400, 'Falta código');
    try {
      const cli = await clientePorCodigo(codigo);
      if (!cli) return ok({ success: false, error: 'Código inválido' });

      const { data: productos } = await supabase.from('productos')
        .select('id, nombre, imagen, stock, precio_mayorista').eq('activo', true).order('nombre');
      const { data: precios } = await supabase.from('precios_mayoristas')
        .select('producto_id, precio').eq('cliente_id', cli.id);
      const mapa = {};
      (precios || []).forEach(p => { mapa[p.producto_id] = Number(p.precio); });

      return ok({
        success: true,
        cliente: { id: cli.id, nombre: cli.nombre },
        productos: (productos || []).map(p => ({
          id: p.id, nombre: p.nombre, imagen: p.imagen, stock: Number(p.stock) || 0,
          precio: mapa[p.id] !== undefined ? mapa[p.id] : (Number(p.precio_mayorista) || 0)
        })).filter(p => p.precio > 0)
      });
    } catch (err) { return bad(500, String(err)); }
  }

  if (event.httpMethod !== 'POST') return bad(405, 'Método no permitido');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return bad(400, 'JSON inválido'); }

  const codigo = String(body.codigo || '').trim();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!codigo) return bad(400, 'Falta código');
  if (!items.length) return bad(400, 'Pedido vacío');

  try {
    const cli = await clientePorCodigo(codigo);
    if (!cli) return ok({ success: false, error: 'Código inválido' });

    // Resolver precios del cliente
    const ids = items.map(i => parseInt(i.productoId, 10)).filter(Boolean);
    const { data: productos } = await supabase.from('productos')
      .select('id, nombre, precio_mayorista').in('id', ids);
    const { data: precios } = await supabase.from('precios_mayoristas')
      .select('producto_id, precio').eq('cliente_id', cli.id);
    const mapaPrecio = {};
    (precios || []).forEach(p => { mapaPrecio[p.producto_id] = Number(p.precio); });
    const mapaProd = {};
    (productos || []).forEach(p => { mapaProd[p.id] = p; });

    let total = 0;
    const detalle = [];
    for (const it of items) {
      const pid = parseInt(it.productoId, 10);
      const cant = Number(it.cantidad) || 0;
      const prod = mapaProd[pid];
      if (!prod || cant <= 0) continue;
      const precio = mapaPrecio[pid] !== undefined ? mapaPrecio[pid] : (Number(prod.precio_mayorista) || 0);
      const subtotal = precio * cant;
      total += subtotal;
      detalle.push({ producto_id: pid, nombre: prod.nombre, cantidad: cant, precio_unitario: precio, subtotal });
    }
    if (!detalle.length) return bad(400, 'No hay ítems válidos');

    // Crear pedido mayorista
    const { data: pedido } = await supabase.from('pedidos').insert({
      canal: 'mayorista', estado: 'pendiente', estado_pago: 'pendiente',
      total, notas: `Mayorista: ${cli.nombre}${body.nota ? ' · ' + body.nota : ''}`
    }).select('id').maybeSingle();

    if (pedido && pedido.id) {
      await supabase.from('detalle_pedidos').insert(
        detalle.map(d => ({ ...d, pedido_id: pedido.id }))
      );
    }

    return ok({ success: true, pedidoId: pedido && pedido.id, total, items: detalle.length });
  } catch (err) {
    return bad(500, String(err));
  }
};
