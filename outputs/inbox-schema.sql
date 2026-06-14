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

create table if not exists commerce_events (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text not null default 'shopify',
  event_type text not null,
  topic text not null,
  event_fingerprint text not null,
  order_id text,
  customer_id text,
  customer_email text,
  phone_e164 text,
  amount numeric(14, 2) not null default 0,
  currency text not null default 'INR',
  raw_payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, event_fingerprint)
);

create table if not exists shopify_customer_index (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  shopify_customer_id text not null,
  phone_e164 text not null,
  wa_id text not null,
  display_name text,
  email text,
  tags text,
  orders_count integer not null default 0,
  total_spent numeric(14, 2) not null default 0,
  currency text not null default 'INR',
  last_order_at timestamptz,
  city text,
  province text,
  country text,
  zip text,
  accepts_marketing boolean,
  shopify_created_at timestamptz,
  shopify_updated_at timestamptz,
  recent_orders jsonb not null default '[]'::jsonb,
  detail_synced_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone_e164)
);

create table if not exists shopify_sync_state (
  organization_id uuid primary key references organizations(id) on delete cascade,
  status text not null default 'idle',
  cursor text,
  checked_count integer not null default 0,
  indexed_count integer not null default 0,
  skipped_count integer not null default 0,
  pages integer not null default 0,
  total_available integer,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table shopify_sync_state
  add column if not exists pages integer not null default 0;

alter table shopify_sync_state
  add column if not exists total_available integer;

alter table shopify_customer_index
  add column if not exists recent_orders jsonb not null default '[]'::jsonb;

alter table shopify_customer_index
  add column if not exists detail_synced_at timestamptz;

create table if not exists automation_runs (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  automation_id text not null,
  automation_name text not null,
  automation_group text not null,
  status text not null default 'would_trigger',
  mode text not null default 'observe',
  trigger_event_id uuid references commerce_events(id) on delete cascade,
  trigger_event_type text not null,
  trigger_reason text,
  order_id text,
  customer_id text,
  customer_email text,
  phone_e164 text,
  amount numeric(14, 2) not null default 0,
  currency text not null default 'INR',
  setup_gap text,
  raw_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (automation_id, trigger_event_id)
);

create table if not exists automation_configs (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  automation_id text not null,
  is_enabled boolean not null default false,
  template_name text,
  template_language text not null default 'en_US',
  wait_minutes integer not null default 0,
  filters jsonb not null default '{}'::jsonb,
  stop_conditions jsonb not null default '{}'::jsonb,
  suppression_rules jsonb not null default '{}'::jsonb,
  fallback_action text not null default 'create_task',
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, automation_id)
);

create table if not exists audience_segments (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  source text not null default 'Combined',
  match_mode text not null default 'all',
  rules jsonb not null default '{}'::jsonb,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists broadcast_campaigns (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  template_name text not null,
  template_language text not null default 'en_US',
  audience_segment_id text,
  audience_label text,
  recipient_count integer not null default 0,
  recipients jsonb not null default '[]'::jsonb,
  send_mode text not null default 'now',
  scheduled_at timestamptz,
  status text not null default 'draft',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  variables jsonb not null default '[]'::jsonb,
  safety_checks jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table broadcast_campaigns
  add column if not exists recipients jsonb not null default '[]'::jsonb;

alter table broadcast_campaigns
  add column if not exists last_send_error text;

create table if not exists broadcast_messages (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid not null references broadcast_campaigns(id) on delete cascade,
  recipient_wa_id text not null,
  provider_message_id text,
  status text not null default 'queued',
  error_message text,
  raw_payload jsonb not null default '{}'::jsonb,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists broadcast_messages_provider_uidx
  on broadcast_messages (organization_id, provider_message_id)
  where provider_message_id is not null;

create table if not exists broadcast_attributions (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid not null references broadcast_campaigns(id) on delete cascade,
  commerce_event_id uuid not null references commerce_events(id) on delete cascade,
  match_type text not null,
  amount numeric(14, 2) not null default 0,
  currency text not null default 'INR',
  created_at timestamptz not null default now(),
  unique (campaign_id, commerce_event_id)
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
create index if not exists commerce_events_org_received_idx on commerce_events (organization_id, received_at desc);
create index if not exists commerce_events_phone_idx on commerce_events (organization_id, phone_e164, received_at desc);
create index if not exists automation_runs_org_created_idx on automation_runs (organization_id, created_at desc);
create index if not exists automation_runs_status_idx on automation_runs (organization_id, status, created_at desc);
create index if not exists automation_configs_org_idx on automation_configs (organization_id, automation_id);
create index if not exists audience_segments_org_updated_idx on audience_segments (organization_id, updated_at desc);

create index if not exists shopify_customer_index_org_customer_idx on shopify_customer_index (organization_id, shopify_customer_id);
create index if not exists shopify_customer_index_org_updated_idx on shopify_customer_index (organization_id, updated_at desc);
create index if not exists shopify_customer_index_org_last_order_idx on shopify_customer_index (organization_id, last_order_at desc);
create index if not exists shopify_customer_index_org_total_spent_idx on shopify_customer_index (organization_id, total_spent desc);
create index if not exists broadcast_campaigns_org_status_idx on broadcast_campaigns (organization_id, status, updated_at desc);
create index if not exists broadcast_campaigns_scheduled_idx on broadcast_campaigns (organization_id, scheduled_at)
  where scheduled_at is not null;
create index if not exists broadcast_messages_campaign_idx on broadcast_messages (campaign_id, created_at desc);
create index if not exists broadcast_messages_status_idx on broadcast_messages (organization_id, status, updated_at desc);
create index if not exists broadcast_attributions_campaign_idx on broadcast_attributions (campaign_id, created_at desc);

-- Optional seed for local MVP development.
insert into organizations (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'The June Shop', 'the-june-shop')
on conflict (slug) do nothing;
