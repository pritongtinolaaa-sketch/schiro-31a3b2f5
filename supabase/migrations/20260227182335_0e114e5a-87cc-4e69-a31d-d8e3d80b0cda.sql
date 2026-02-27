-- Temp mail inboxes
create table if not exists public.temp_mail_inboxes (
  id uuid primary key default gen_random_uuid(),
  email_address text not null unique,
  token_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 day')
);

create index if not exists temp_mail_inboxes_expires_at_idx
  on public.temp_mail_inboxes (expires_at);

-- Temp mail messages
create table if not exists public.temp_mail_messages (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null references public.temp_mail_inboxes(id) on delete cascade,
  from_address text not null,
  subject text not null,
  body text not null,
  received_at timestamptz not null default now()
);

create index if not exists temp_mail_messages_inbox_id_received_at_idx
  on public.temp_mail_messages (inbox_id, received_at desc);

-- Lock down direct client access; Edge Functions will access using service role.
alter table public.temp_mail_inboxes enable row level security;
alter table public.temp_mail_messages enable row level security;