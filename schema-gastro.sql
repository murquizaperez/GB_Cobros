-- ============================================================
-- MONNOSERIE GASTRO · Schema completo del sistema gastronómico
-- Ejecutar en Supabase → SQL Editor (DESPUÉS de schema.sql + migracion-cadena.sql)
-- Crea las tablas que faltan para el sistema completo (Gastro System sobre Supabase)
-- ============================================================

-- ── Soporte POS + imagen en productos (de migracion-pos.sql, incluido acá) ──
alter table pedidos drop constraint if exists pedidos_canal_check;
alter table pedidos add constraint pedidos_canal_check
  check (canal in ('minorista','mayorista','pos'));
alter table productos add column if not exists imagen text default '';
alter table productos add column if not exists costo_unitario numeric(12,2) default 0;
create index if not exists idx_pedidos_fecha on pedidos(fecha_pedido);
create index if not exists idx_pedidos_estado_pago on pedidos(estado_pago);

-- ── INGREDIENTES (materia prima) ──
create table if not exists ingredientes (
  id              bigint generated always as identity primary key,
  nombre          text not null,
  unidad          text not null default 'g',      -- g, kg, ml, l, unidad
  stock_actual    numeric(12,3) not null default 0,
  stock_minimo    numeric(12,3) not null default 0,
  costo_unitario  numeric(12,4) not null default 0, -- costo por unidad base
  activo          boolean not null default true,
  actualizado_en  timestamptz not null default now()
);
create index if not exists idx_ingredientes_activo on ingredientes(activo);

-- ── RECETAS (qué ingredientes lleva cada producto, por unidad producida) ──
create table if not exists recetas (
  id             bigint generated always as identity primary key,
  producto_id    bigint not null references productos(id) on delete cascade,
  ingrediente_id bigint not null references ingredientes(id) on delete cascade,
  cantidad       numeric(12,4) not null default 0,   -- cantidad del ingrediente por 1 unidad de producto
  unique (producto_id, ingrediente_id)
);
create index if not exists idx_recetas_producto on recetas(producto_id);

-- ── LOTES DE PRODUCCIÓN ──
create table if not exists lotes_produccion (
  id                 bigint generated always as identity primary key,
  producto_id        bigint not null references productos(id),
  cantidad_producida numeric(12,2) not null default 0,
  costo_total        numeric(12,2) not null default 0,
  ingredientes_ok    boolean not null default false, -- si se descontó materia prima
  responsable        text default '',
  notas              text default '',
  fecha              timestamptz not null default now()
);
create index if not exists idx_lotes_producto on lotes_produccion(producto_id);
create index if not exists idx_lotes_fecha on lotes_produccion(fecha);

-- ── CAJAS (sesiones de apertura/cierre) ──
create table if not exists cajas (
  id              bigint generated always as identity primary key,
  estado          text not null default 'abierta',  -- abierta | cerrada
  responsable     text default '',
  monto_apertura  numeric(12,2) not null default 0,
  monto_cierre    numeric(12,2),
  total_ventas    numeric(12,2) not null default 0,
  abierta_en      timestamptz not null default now(),
  cerrada_en      timestamptz
);
create index if not exists idx_cajas_estado on cajas(estado);

-- ── MOVIMIENTOS DE CAJA (ingresos/egresos manuales) ──
create table if not exists movimientos_caja (
  id          bigint generated always as identity primary key,
  caja_id     bigint references cajas(id) on delete cascade,
  tipo        text not null,        -- ingreso | egreso | venta
  monto       numeric(12,2) not null default 0,
  concepto    text default '',
  creado_en   timestamptz not null default now()
);
create index if not exists idx_mov_caja on movimientos_caja(caja_id);

-- ── Vincular ventas POS a la caja (campo en pedidos) ──
alter table pedidos add column if not exists caja_id bigint references cajas(id);

-- Verificación
select 'ok' as estado,
  (select count(*) from information_schema.tables where table_name='ingredientes') as t_ingredientes,
  (select count(*) from information_schema.tables where table_name='recetas') as t_recetas,
  (select count(*) from information_schema.tables where table_name='lotes_produccion') as t_lotes,
  (select count(*) from information_schema.tables where table_name='cajas') as t_cajas;
