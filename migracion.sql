-- ============================================================
-- MONNOSHOP · MIGRACIÓN DE DATOS HISTÓRICOS
-- ============================================================
-- Ejecutar DESPUÉS de schema.sql (necesita las tablas y los 23 productos).
-- Pegar todo en: Supabase → SQL Editor → New query → Run
--
-- Contenido:
--   1) 34 clientes (de los 36 hardcodeados en gastro.html; 2 duplicados
--      por teléfono compartido fueron omitidos automáticamente).
--   2) 4 pedidos históricos de la pestaña "Pedidos" del Sheet, con su
--      detalle mapeado por NOMBRE de producto al catálogo nuevo.
--
-- Notas importantes:
--   - Los clientes "mariano / mariano meneo / mariano motta" de los pedidos
--     comparten el teléfono 2615023915, que pertenece a 'mariano meneo' en
--     la tabla de clientes. Por eso los 4 pedidos quedan asociados a ese
--     cliente. Si querés separarlos, hay que darles teléfonos distintos.
--   - El producto "Chipa monno" del histórico NO existe en el catálogo nuevo
--     de los 23, así que esas líneas se omiten y el total del pedido se
--     recalcula solo con los productos que sí existen.
--   - Es idempotente en clientes (telefono es unique): si lo corrés dos
--     veces, la segunda tirará error de duplicado en clientes. Para recargar,
--     borrá primero o usá la cláusula on conflict (ver abajo).
-- ============================================================


insert into clientes (nombre, telefono, email, direccion, tipo) values
  ('Cafe555', '2612375547', 'martinabernardita24@gmail.com', 'Italia 5649', 'minorista'),
  ('Hotel entre cielo', '26102029394', 'salinasivan_97_@outlook.es', 'Guardia Vieja 1998', 'minorista'),
  ('Lisa colque', '2615161080', 'lisacolque@gmail.com', 'Mitre 756', 'minorista'),
  ('DELIS CAFÉ VINTAGE SHOP', '2613415823', 'deliscafevintageshop@gmail.com', 'Aristides 570- Ciudad', 'minorista'),
  ('Victorina Coria', '2616903835', 'admvictorina@gmail.com', 'Viamonte 5458', 'minorista'),
  ('Juan Pablo', '2617550252', 'juanmma150@gmail.com', 'Pueyrredon 57,Rodeo del Medio', 'minorista'),
  ('Trazo Dulce SAS', '2615339449', 'trazodulcepasteleria@gmail.com', 'Pueyrredón 5301 esquina Panamericana, Chacras de Coria, Mendoza', 'mayorista'),
  ('cafe black mamba', '2617480193', 'benitocafesas@gmail.com', 'almirante brown 1840 barrio bombal godoy cruz', 'minorista'),
  ('Jimena Garcia Zapata', '2612541375', 'jimenagarciazapata@gmail.com', 'Aguinaga 1392, chacras de coria', 'minorista'),
  ('Matias Exequiel Contreras', '2616902709', 'matiascontre@hotmail.com', 'Taboada 764', 'minorista'),
  ('Patio Godoy', '2615169547', 'cafegbx@gmail.com', 'Pedro J Godoy 880, Local 2', 'minorista'),
  ('Berry Good', '2617071426', 'luciano.emoreno94@gmail.com', 'Colón 189. Ciudad', 'minorista'),
  ('Agustin Hospital Lagomaggiore', '155023915', 'motta@gmail.com', 'Timoteo Gordillo s/n, Mendoza, CP 5500.', 'minorista'),
  ('La veredita', '2616935575', 'machifarru@gmail.com', 'Aristides Villanueva 770 ciudad', 'minorista'),
  ('Olivicola Centenario', '2615594263', 'administracion@olivarescentenario.com', 'Centenario olivicola', 'mayorista'),
  ('mariano meneo', '2615023915', 'meneo10@gmail.com', 'guiñazu 162', 'minorista'),
  ('Carolina Arenas', '2615061001', 'caroarenasww@gmail.com', 'Chuquisaca 1050, Godoy Cruz', 'minorista'),
  ('Camila cruz', '2615595885', 'camilacruz2468@hotmail.com', 'Aristides Villanueva 396', 'minorista'),
  ('fabrio', '2616754627', 'fabripiffa@gmail.com', 'GUIÑAZU 162', 'minorista'),
  ('Celeste micaela celedon', '2617451140', 'cele271530@gmail.com', 'Goya chacras Darrahueria 558', 'minorista'),
  ('Ramiro Gil', '2615878148', 'ramiro.gil13@gmail.com', 'Perón 219, Maipú, Mendoza', 'minorista'),
  ('Martín Durán', '2616412296', 'martinnicolasduran5@gmail.com', 'lencinas 595, Godoy Cruz, Monoblock D, Dpto 10', 'minorista'),
  ('Facundo Badaloni', '2613053100', 'facundobadaloni6@gmail.com', 'Aristides 751, Ciudad de Mendoza', 'minorista'),
  ('Gabriela Díaz', '2616709395', 'amarenadulces@yahoo.com.ar', 'Beltran 316 Godoy Cruz Entre Cabildo Abierto y Reconquista', 'minorista'),
  ('Brian Stubbia', '2612478286', 'brianstubbia35@gmail.com', 'Julio A Roca 379', 'minorista'),
  ('Micaela Flores', '2616376345', 'aylinmicaela26@gmail.com', 'Catamarca 20 ciudad', 'minorista'),
  ('Cactus Café', '2613069984', 'cactuscafemza@gmail.com', 'Pascual Segura 1076, Godoy Cruz', 'minorista'),
  ('Federico Jesús Soler Nonino', '2615710100', 'federico.soler.arq@gmail.com', 'Barrio Natania 25 mzna G casa 10', 'minorista'),
  ('Hernán cuello', '2616901935', 'chichocapo_9@hotmail.com', 'Juan b justo 88 de ciudad', 'minorista'),
  ('MijuBurgers', '2617788880', 'mijuburgers@gmail.com', 'Pedro J. Godoy 880', 'minorista'),
  ('Adrián Milano', '1162939506', 'lapeste.victor@gmail.com', 'Martin Zapata 407 Mendoza ciudad', 'minorista'),
  ('Lucas Orosco', '2617620307', 'lucasorosco11@gmail.com', 'Pedro j Godoy 880', 'minorista'),
  ('Silvina Natalia', '2614170250', 'silvinanmartinez@hotmail.com', 'San Martin 1665', 'minorista'),
  ('Giuliana Bernardi', '2615177418', 'giulianabernardi99@outlook.com', 'Lamadrid 520 - 5ta Sección- Ciudad de Mendoza', 'minorista')
on conflict (telefono) do nothing;

-- PEDIDOS HISTÓRICOS (4 pedidos del Sheet gastronómico)
-- Se insertan asociados al cliente por teléfono.
-- Productos mapeados por nombre al catálogo nuevo.

-- ⚠️  Productos del histórico que NO existen en el catálogo nuevo (se omiten esas líneas):
--    - Chipa monno

do $$
declare v_cli bigint; v_ped bigint; v_prod bigint;
begin
  -- Pedido 599befe2 (mariano)
  select id into v_cli from clientes where telefono = '2615023915' limit 1;
  if v_cli is not null then
    insert into pedidos (cliente_id, canal, fecha_pedido, fecha_entrega, estado, total, notas, medio_pago, estado_pago)
    values (v_cli, 'minorista', '2026-05-26 17:35:54', '2026-05-27', 'entregado', 24000, 'cocido', 'Transferencia', 'pendiente') returning id into v_ped;
    select id into v_prod from productos where nombre = 'Baguette' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Baguette', 2, 2000, 4000); end if;
    select id into v_prod from productos where nombre = 'Dannesa' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Dannesa', 2, 4000, 8000); end if;
    select id into v_prod from productos where nombre = 'Pan de campo' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Pan de campo', 2, 6000, 12000); end if;
  end if;

  -- Pedido e090cc0e (mariano)
  select id into v_cli from clientes where telefono = '2615023915' limit 1;
  if v_cli is not null then
    insert into pedidos (cliente_id, canal, fecha_pedido, fecha_entrega, estado, total, notas, medio_pago, estado_pago)
    values (v_cli, 'minorista', '2026-05-26 18:07:10', '2026-05-27', 'pendiente', 22500, '', 'Transferencia', 'pendiente') returning id into v_ped;
    select id into v_prod from productos where nombre = 'Baguette' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Baguette', 2, 2000, 4000); end if;
    select id into v_prod from productos where nombre = 'Croissant' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Croissant', 1, 2000, 2000); end if;
    select id into v_prod from productos where nombre = 'Pan de campo' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Pan de campo', 1, 6000, 6000); end if;
    select id into v_prod from productos where nombre = 'Medialuna 60g' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Medialuna 60g', 1, 1500, 1500); end if;
    select id into v_prod from productos where nombre = 'Shoku Pan' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Shoku Pan', 1, 5000, 5000); end if;
    select id into v_prod from productos where nombre = 'Dannesa' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Dannesa', 1, 4000, 4000); end if;
  end if;

  -- Pedido 02c83bfe (mariano meneo)
  select id into v_cli from clientes where telefono = '2615023915' limit 1;
  if v_cli is not null then
    insert into pedidos (cliente_id, canal, fecha_pedido, fecha_entrega, estado, total, notas, medio_pago, estado_pago)
    values (v_cli, 'minorista', '2026-06-01 20:15:44', '2026-06-02', 'pendiente', 4000, 'retiro', 'Efectivo', 'pendiente') returning id into v_ped;
    select id into v_prod from productos where nombre = 'Croissant' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Croissant', 2, 2000, 4000); end if;
  end if;

  -- Pedido dc7659e4 (mariano motta)
  select id into v_cli from clientes where telefono = '2615023915' limit 1;
  if v_cli is not null then
    insert into pedidos (cliente_id, canal, fecha_pedido, fecha_entrega, estado, total, notas, medio_pago, estado_pago)
    values (v_cli, 'minorista', '2026-06-01 20:53:45', '2026-06-02', 'pendiente', 10000, '', 'Efectivo', 'pendiente') returning id into v_ped;
    select id into v_prod from productos where nombre = 'Baguette' limit 1;
    if v_prod is not null then insert into detalle_pedidos (pedido_id, producto_id, nombre, cantidad, precio_unitario, subtotal) values (v_ped, v_prod, 'Baguette', 5, 2000, 10000); end if;
  end if;

end $$;

-- Verificación final
select (select count(*) from clientes) as clientes, (select count(*) from pedidos) as pedidos, (select count(*) from detalle_pedidos) as lineas;
