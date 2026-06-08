-- ============================================================
-- MONNOSHOP · Migración para la cadena automática de pagos (Opción B)
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql y migracion.sql
-- ============================================================

-- 1) Campos nuevos en PEDIDOS
alter table pedidos add column if not exists quiere_factura  boolean      not null default false;
alter table pedidos add column if not exists factura_cuit    text         default '';   -- CUIT/DNI del cliente si pide factura
alter table pedidos add column if not exists mp_payment_id   text         default '';   -- id del pago de Mercado Pago
alter table pedidos add column if not exists pagado_en       timestamptz;               -- cuándo se confirmó el pago
alter table pedidos add column if not exists stock_descontado boolean     not null default false; -- evita descontar 2 veces

-- 2) Tabla FACTURAS (resultado de ARCA)
create table if not exists facturas (
  id                bigint generated always as identity primary key,
  pedido_id         bigint references pedidos(id),
  afip_numero       text,                 -- 0003-00000123
  cae               text,
  cae_vto           text,
  importe           numeric(12,2) not null default 0,
  tipo              text default 'C',
  punto_venta       text default '',
  qr_url            text default '',
  concepto          text default '',
  emitida_en        timestamptz not null default now(),
  error             text default ''       -- si ARCA rechazó, queda el motivo acá
);
create index if not exists idx_facturas_pedido on facturas(pedido_id);

-- 3) Log de eventos de la cadena (para debug/monitoreo — otro de los dolores de GAS)
create table if not exists eventos_pedido (
  id          bigint generated always as identity primary key,
  pedido_id   bigint references pedidos(id),
  tipo        text not null,        -- 'pago_confirmado' | 'stock_descontado' | 'factura_emitida' | 'error'
  detalle     text default '',
  creado_en   timestamptz not null default now()
);
create index if not exists idx_eventos_pedido on eventos_pedido(pedido_id);

-- Verificación
select 'ok' as estado,
  (select count(*) from information_schema.columns where table_name='pedidos' and column_name='quiere_factura') as tiene_quiere_factura;
