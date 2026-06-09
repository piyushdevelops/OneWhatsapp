-- WhatsApp Inbox MVP schema
-- Target: Postgres 14+

create table if not exists organizations (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists team_users (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null default 'agent',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);

create table if not exists whatsapp_channels (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  waba_id text not null,
  phone_number_id text not null,
  display_phone_number text,
  business_display_name text,
  graph_api_version text not null default 'v23.0',
  access_token_encrypted text,
  verify_token_hash text,
  webhook_status text not null default 'pending',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone_number_id)
);

create table if not exists contacts (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  wa_id text,
  phone_e164 text not null,
  display_name text,
  email text,
  opt_in_status text not null default 'unknown',
  opt_in_source text,
  last_inbound_at timestamptz,
  customer_service_window_expires_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone_e164)
);

create table if not exists conversations (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_id uuid not null references whatsapp_channels(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  status text not null default 'open',
  priority text not null default 'normal',
  assigned_to_user_id uuid references team_users(id) on delete set null,
  source text not null default 'whatsapp',
  intent text,
  sentiment text,
  unread_count integer not null default 0,
  last_message_at timestamptz,
  last_customer_message_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_id uuid not null references whatsapp_channels(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  direction text not null,
  message_type text not null,
  body text,
  media_id text,
  media_url text,
  template_name text,
  provider_message_id text,
  status text not null default 'received',
  error_code text,
  error_message text,
  raw_payload jsonb not null default '{}'::jsonb,
  sent_by_user_id uuid references team_users(id) on delete set null,
  provider_timestamp timestamptz,
  queued_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists messages_provider_message_id_uidx
  on messages (organization_id, provider_message_id)
  where provider_message_id is not null;

create table if not exists webhook_events (
  id uuid primary key,
  organization_id uuid references organizations(id) on delete cascade,
  channel_id uuid references whatsapp_channels(id) on delete set null,
  provider text not null default 'meta_whatsapp',
  event_type text not null,
  event_fingerprint text not null,
  provider_message_id text,
  processing_status text not null default 'pending',
  raw_payload jsonb not null,
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_fingerprint)
);

create table if not exists conversation_notes (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  author_user_id uuid references team_users(id) on delete set null,
  note text not null,
  created_at timestamptz not null default now()
);

create table if not exists tags (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists conversation_tags (
  conversation_id uuid not null references conversations(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, tag_id)
);

create table if not exists audit_logs (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_user_id uuid references team_users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists contacts_org_last_inbound_idx on contacts (organization_id, last_inbound_at desc);
create index if not exists conversations_org_status_last_idx on conversations (organization_id, status, last_message_at desc);
create index if not exists conversations_assignee_idx on conversations (organization_id, assigned_to_user_id, status);
create index if not exists messages_conversation_created_idx on messages (conversation_id, created_at asc);
create index if not exists messages_status_idx on messages (organization_id, status, created_at desc);
create index if not exists webhook_events_status_idx on webhook_events (processing_status, received_at asc);

-- Optional seed for local MVP development.
insert into organizations (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'The June Shop', 'the-june-shop')
on conflict (slug) do nothing;
