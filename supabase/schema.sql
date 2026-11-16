-- OnlyClick — esquema de Supabase (Postgres)
-- En el SQL Editor de tu proyecto Supabase, pega y ejecuta todo esto.
-- Después crea el bucket "photos" en Storage (público) o ejecuta el
-- INSERT de abajo con la política que prefieras. La app lee las fotos
-- a través del servidor (api/photo), así que el bucket NO necesita ser
-- público para descargar: el servidor usa la service_role key.

create table if not exists users (
  id bigint generated always as identity primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('photographer', 'athlete')),
  tip_clabe text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists events (
  id bigint generated always as identity primary key,
  photographer_id bigint not null references users(id),
  name text not null,
  sport text not null default 'Carrera',
  event_date text not null default '',
  location text not null default '',
  free_mode boolean not null default true,
  price_mxn numeric not null default 20,
  cover_path text not null default '',
  created_at timestamptz not null default now()
);

-- Precio por foto del evento (MXN). En bases ya creadas, correr el ALTER
-- de abajo. Si es 0 o falta, el checkout usa $20.
alter table events add column if not exists price_mxn numeric not null default 20;

-- Pagos con Clip: un renglón por intento de cobro (link creado).
-- status: pending | completed | cancelled | expired. La descarga real
-- vive en downloads (con amount > 0); esta tabla es el rastro del pago.
create table if not exists payments (
  id bigint generated always as identity primary key,
  clip_payment_request_id text not null unique,
  external_reference text not null default '',
  user_id bigint not null references users(id),
  photo_id bigint not null references photos(id) on delete cascade,
  event_id bigint not null references events(id) on delete cascade,
  amount numeric not null,
  currency text not null default 'MXN',
  status text not null default 'pending',
  receipt_no text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_payments_clip on payments(clip_payment_request_id);
create index if not exists idx_payments_user_photo on payments(user_id, photo_id);

create table if not exists photos (
  id bigint generated always as identity primary key,
  event_id bigint not null references events(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  bibs text[] not null default '{}',
  price numeric not null default 0,
  storage_path text not null,
  thumb_path text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists downloads (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  photo_id bigint not null references photos(id) on delete cascade,
  event_id bigint not null references events(id) on delete cascade,
  amount numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_photos_event on photos(event_id);
create index if not exists idx_downloads_user on downloads(user_id);
create index if not exists idx_downloads_photo on downloads(photo_id);

-- Bucket de fotos (Storage). Créalo en el panel de Supabase > Storage
-- con nombre "photos". Con service_role key el servidor puede subir y
-- leer sin políticas públicas. Si quieres, deja el bucket privado.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;
