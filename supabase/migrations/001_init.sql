begin;

create extension if not exists pgcrypto;

-- Muse Coordination Hub: eight tenant-scoped application tables.
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  owner_id uuid not null references auth.users(id) on delete cascade,
  agent_limit smallint not null default 10,
  agent_invite_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_agent_limit_check check (agent_limit between 1 and 10),
  constraint workspaces_owner_name_unique unique (owner_id, name)
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  role text not null check (char_length(role) between 1 and 120),
  api_key_hash text not null unique,
  status text not null default 'offline'
    check (status in ('online', 'idle', 'offline', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agents_id_workspace_unique unique (id, workspace_id)
);

create unique index if not exists agents_workspace_display_name_unique
  on public.agents (workspace_id, lower(display_name))
  where status <> 'revoked';

create index if not exists agents_workspace_status_idx
  on public.agents (workspace_id, status, last_seen_at desc);

create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  channel_type text not null default 'group'
    check (channel_type in ('group', 'dm')),
  member_agent_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channels_id_workspace_unique unique (id, workspace_id),
  constraint channels_dm_members_check check (
    channel_type = 'group'
    or cardinality(member_agent_ids) between 1 and 2
  )
);

create unique index if not exists channels_group_name_unique
  on public.channels (workspace_id, lower(name))
  where channel_type = 'group';

create index if not exists channels_dm_members_gin_idx
  on public.channels using gin (member_agent_ids)
  where channel_type = 'dm';

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  channel_id uuid not null,
  sender_type text not null check (sender_type in ('owner', 'agent', 'system')),
  sender_id uuid,
  body text not null check (char_length(body) between 1 and 20000),
  message_type text not null default 'NOTE'
    check (message_type in ('NOTE', 'TASK', 'HANDOFF', 'ALERT', 'DONE')),
  mentions uuid[] not null default '{}',
  reply_to uuid references public.messages(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint messages_channel_workspace_fk
    foreign key (channel_id, workspace_id)
    references public.channels(id, workspace_id)
    on delete cascade,
  constraint messages_sender_check check (
    (sender_type = 'system' and sender_id is null)
    or (sender_type in ('owner', 'agent') and sender_id is not null)
  )
);

create index if not exists messages_channel_created_idx
  on public.messages (channel_id, created_at desc);
create index if not exists messages_workspace_created_idx
  on public.messages (workspace_id, created_at desc);
create index if not exists messages_mentions_gin_idx
  on public.messages using gin (mentions);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id uuid,
  title text not null check (char_length(title) between 1 and 240),
  detail text not null default '' check (char_length(detail) <= 20000),
  assigned_to uuid,
  created_by uuid not null,
  created_by_type text not null check (created_by_type in ('owner', 'agent')),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'IN_PROGRESS', 'DONE', 'ESCALATED', 'BLOCKED')),
  due_at timestamptz,
  result_link text check (result_link is null or char_length(result_link) <= 2048),
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 2000),
  locked_by uuid,
  locked_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_id_workspace_unique unique (id, workspace_id),
  constraint tasks_channel_workspace_fk
    foreign key (channel_id, workspace_id)
    references public.channels(id, workspace_id)
    on delete set null,
  constraint tasks_assigned_agent_workspace_fk
    foreign key (assigned_to, workspace_id)
    references public.agents(id, workspace_id)
    on delete set null,
  constraint tasks_locked_agent_workspace_fk
    foreign key (locked_by, workspace_id)
    references public.agents(id, workspace_id)
    on delete set null,
  constraint tasks_lock_state_check check (
    (status = 'PENDING' and locked_by is null and locked_at is null)
    or status <> 'PENDING'
  ),
  constraint tasks_blocked_reason_check check (
    status <> 'BLOCKED' or nullif(btrim(blocked_reason), '') is not null
  )
);

create index if not exists tasks_workspace_status_idx
  on public.tasks (workspace_id, status, due_at);
create index if not exists tasks_assigned_status_idx
  on public.tasks (assigned_to, status, created_at desc);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid,
  name text not null check (char_length(name) between 1 and 255),
  storage_path text not null unique check (char_length(storage_path) between 1 and 1024),
  content_type text check (content_type is null or char_length(content_type) <= 255),
  size_bytes bigint not null check (size_bytes >= 0),
  uploaded_by uuid not null,
  uploaded_by_type text not null check (uploaded_by_type in ('owner', 'agent')),
  state text not null default 'uploaded'
    check (state in ('uploaded', 'picked', 'posted', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint files_task_workspace_fk
    foreign key (task_id, workspace_id)
    references public.tasks(id, workspace_id)
    on delete set null
);

create index if not exists files_workspace_task_idx
  on public.files (workspace_id, task_id, created_at desc);

create table if not exists public.schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null,
  label text not null check (char_length(label) between 1 and 160),
  time_rule text not null check (char_length(time_rule) between 1 and 255),
  task_template jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedules_agent_workspace_fk
    foreign key (agent_id, workspace_id)
    references public.agents(id, workspace_id)
    on delete cascade
);

create index if not exists schedules_due_idx
  on public.schedules (workspace_id, active, next_run_at)
  where active;

create table if not exists public.heartbeats (
  agent_id uuid primary key,
  workspace_id uuid not null,
  seen_at timestamptz not null default now(),
  status text not null default 'online'
    check (status in ('online', 'idle', 'offline')),
  metadata jsonb not null default '{}'::jsonb,
  constraint heartbeats_agent_workspace_fk
    foreign key (agent_id, workspace_id)
    references public.agents(id, workspace_id)
    on delete cascade
);

create index if not exists heartbeats_workspace_seen_idx
  on public.heartbeats (workspace_id, seen_at desc);

-- Keep updated_at deterministic without requiring application cooperation.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_workspaces_updated_at
before update on public.workspaces
for each row execute function public.set_updated_at();

create trigger set_agents_updated_at
before update on public.agents
for each row execute function public.set_updated_at();

create trigger set_channels_updated_at
before update on public.channels
for each row execute function public.set_updated_at();

create trigger set_tasks_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

create trigger set_files_updated_at
before update on public.files
for each row execute function public.set_updated_at();

create trigger set_schedules_updated_at
before update on public.schedules
for each row execute function public.set_updated_at();

-- The database is the final authority for the per-workspace ten-agent ceiling.
create or replace function public.enforce_workspace_agent_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed_agents smallint;
  current_agents integer;
begin
  if new.status = 'revoked' then
    return new;
  end if;

  select least(agent_limit, 10)
    into allowed_agents
    from public.workspaces
   where id = new.workspace_id
   for update;

  if allowed_agents is null then
    raise exception using errcode = '23503', message = 'workspace_not_found';
  end if;

  select count(*)
    into current_agents
    from public.agents
   where workspace_id = new.workspace_id
     and status <> 'revoked'
     and id <> new.id;

  if current_agents >= allowed_agents then
    raise exception using errcode = 'P0001', message = 'agent_limit_reached';
  end if;

  return new;
end;
$$;

create trigger enforce_agents_per_workspace
before insert or update of workspace_id, status on public.agents
for each row execute function public.enforce_workspace_agent_limit();

-- Registration is atomic: verify invite hash, lock workspace, then insert.
create or replace function public.register_agent(
  p_workspace_id uuid,
  p_invite_key_hash text,
  p_display_name text,
  p_role text,
  p_api_key_hash text
)
returns public.agents
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace public.workspaces;
  created_agent public.agents;
begin
  select *
    into target_workspace
    from public.workspaces
   where id = p_workspace_id
   for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'workspace_not_found';
  end if;

  if target_workspace.agent_invite_hash <> p_invite_key_hash then
    raise exception using errcode = 'P0001', message = 'invalid_invite_key';
  end if;

  insert into public.agents (
    workspace_id,
    display_name,
    role,
    api_key_hash,
    status
  ) values (
    p_workspace_id,
    btrim(p_display_name),
    btrim(p_role),
    p_api_key_hash,
    'offline'
  )
  returning * into created_agent;

  return created_agent;
end;
$$;

revoke all on function public.register_agent(uuid, text, text, text, text) from public;
grant execute on function public.register_agent(uuid, text, text, text, text) to service_role;

-- Every workspace starts with the three protocol channels; no agent seed data is created.
create or replace function public.create_default_channels()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.channels (workspace_id, name, channel_type)
  values
    (new.id, 'general', 'group'),
    (new.id, 'handoff', 'group'),
    (new.id, 'alerts', 'group');
  return new;
end;
$$;

create trigger create_workspace_default_channels
after insert on public.workspaces
for each row execute function public.create_default_channels();

-- A heartbeat also refreshes the agent presence row.
create or replace function public.sync_agent_presence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.agents
     set last_seen_at = new.seen_at,
         status = new.status
   where id = new.agent_id
     and workspace_id = new.workspace_id
     and status <> 'revoked';
  return new;
end;
$$;

create trigger sync_agent_presence_from_heartbeat
after insert or update on public.heartbeats
for each row execute function public.sync_agent_presence();

-- Owner-facing RLS. Agent keys never reach Supabase directly; bridge calls are
-- authenticated and workspace-scoped by server API routes using the service role.
create or replace function public.is_workspace_owner(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.workspaces
     where id = target_workspace_id
       and owner_id = auth.uid()
  );
$$;

revoke all on function public.is_workspace_owner(uuid) from public;
grant execute on function public.is_workspace_owner(uuid) to authenticated;

alter table public.workspaces enable row level security;
alter table public.agents enable row level security;
alter table public.channels enable row level security;
alter table public.messages enable row level security;
alter table public.tasks enable row level security;
alter table public.files enable row level security;
alter table public.schedules enable row level security;
alter table public.heartbeats enable row level security;

alter table public.workspaces force row level security;
alter table public.agents force row level security;
alter table public.channels force row level security;
alter table public.messages force row level security;
alter table public.tasks force row level security;
alter table public.files force row level security;
alter table public.schedules force row level security;
alter table public.heartbeats force row level security;

create policy workspaces_owner_select on public.workspaces
for select to authenticated
using (owner_id = auth.uid());

create policy workspaces_owner_insert on public.workspaces
for insert to authenticated
with check (owner_id = auth.uid());

create policy workspaces_owner_update on public.workspaces
for update to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy workspaces_owner_delete on public.workspaces
for delete to authenticated
using (owner_id = auth.uid());

create policy agents_owner_all on public.agents
for all to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

create policy channels_owner_all on public.channels
for all to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

create policy messages_owner_all on public.messages
for all to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

create policy tasks_owner_all on public.tasks
for all to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

create policy files_owner_all on public.files
for all to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

create policy schedules_owner_all on public.schedules
for all to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

create policy heartbeats_owner_all on public.heartbeats
for all to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

revoke all on table public.workspaces, public.agents, public.channels,
  public.messages, public.tasks, public.files, public.schedules,
  public.heartbeats from anon;

grant select, insert, update, delete on table public.workspaces, public.agents,
  public.channels, public.messages, public.tasks, public.files,
  public.schedules, public.heartbeats to authenticated;

-- Add workspace activity to Realtime when running inside Supabase. The guard
-- keeps this migration usable in plain PostgreSQL validation environments.
do $$
declare
  realtime_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach realtime_table in array array[
      'workspaces', 'agents', 'channels', 'messages',
      'tasks', 'files', 'schedules', 'heartbeats'
    ]
    loop
      if not exists (
        select 1
          from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = realtime_table
      ) then
        execute format(
          'alter publication supabase_realtime add table public.%I',
          realtime_table
        );
      end if;
    end loop;
  end if;
end;
$$;

-- Supabase Storage remains private; server API routes will issue scoped operations.
insert into storage.buckets (id, name, public, file_size_limit)
values ('handoffs', 'handoffs', false, 52428800)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

commit;
