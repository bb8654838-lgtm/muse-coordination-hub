-- Stage A: immutable owner-managed desired configuration. No agent/runtime defaults.
begin;
create table if not exists public.workspace_roles (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 name text not null check (length(name) between 1 and 120), description text not null default '' check (length(description)<=2000),
 current_version integer not null default 1 check(current_version>0), created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,workspace_id)
);
create unique index if not exists workspace_roles_name_idx on public.workspace_roles(workspace_id,lower(name));
create table if not exists public.workspace_role_versions (
 role_id uuid not null, workspace_id uuid not null, version integer not null check(version>0),
 name text not null, description text not null, instructions text not null default '' check(length(instructions)<=20000),
 skills jsonb not null default '[]' check(jsonb_typeof(skills)='array' and jsonb_array_length(skills)<=64),
 permissions jsonb not null default '{}' check(jsonb_typeof(permissions)='object'), created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), primary key(role_id,version), unique(role_id,version,workspace_id),
 foreign key(role_id,workspace_id) references public.workspace_roles(id,workspace_id) on delete cascade
);
create table if not exists public.workspace_skill_versions (
 skill_id uuid not null, workspace_id uuid not null references public.workspaces(id) on delete cascade,
 version integer not null check(version>0), name text not null check(length(name) between 1 and 120),
 description text not null check(length(description)<=500), content text not null check(length(content)<=100000),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'), created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), primary key(skill_id,version), unique(skill_id,version,workspace_id)
);
create index if not exists workspace_skill_versions_workspace_idx on public.workspace_skill_versions(workspace_id,skill_id,version desc);
create unique index if not exists agents_id_workspace_configuration_idx on public.agents(id,workspace_id);
create table if not exists public.agent_config_state (
 agent_id uuid primary key, workspace_id uuid not null,
 desired_revision integer not null default 0 check(desired_revision>=0), applied_revision integer not null default 0,
 desired_configuration jsonb not null default '{"role":null,"skills":[],"instructions":"","permissions":{}}' check(jsonb_typeof(desired_configuration)='object'),
 updated_by uuid references auth.users(id), updated_at timestamptz not null default now(),
 unique(agent_id,workspace_id), check(applied_revision>=0 and applied_revision<=desired_revision),
 foreign key(agent_id,workspace_id) references public.agents(id,workspace_id) on delete cascade
);
create table if not exists public.agent_config_revisions (
 agent_id uuid not null, workspace_id uuid not null, revision integer not null check(revision>0),
 configuration jsonb not null check(jsonb_typeof(configuration)='object'), resolved_bundle jsonb not null check(jsonb_typeof(resolved_bundle)='object'),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), primary key(agent_id,revision),
 foreign key(agent_id,workspace_id) references public.agents(id,workspace_id) on delete cascade
);
create table if not exists public.agent_config_events (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 agent_id uuid, revision integer, actor_id uuid not null references auth.users(id),
 event_type text not null check(event_type in ('configuration_saved','role_created','role_version_created','skill_version_created')),
 metadata jsonb not null default '{}' check(jsonb_typeof(metadata)='object'), created_at timestamptz not null default now(),
 foreign key(agent_id,workspace_id) references public.agents(id,workspace_id) on delete cascade
);
create index if not exists agent_config_events_workspace_idx on public.agent_config_events(workspace_id,created_at desc);
-- Ownership follows the workspace, not the untrusted JSON/body owner fields.
alter table public.workspace_roles enable row level security;
alter table public.workspace_roles force row level security;
alter table public.workspace_role_versions enable row level security;
alter table public.workspace_role_versions force row level security;
alter table public.workspace_skill_versions enable row level security;
alter table public.workspace_skill_versions force row level security;
alter table public.agent_config_state enable row level security;
alter table public.agent_config_state force row level security;
alter table public.agent_config_revisions enable row level security;
alter table public.agent_config_revisions force row level security;
alter table public.agent_config_events enable row level security;
alter table public.agent_config_events force row level security;
do $$ declare table_name text; begin
 foreach table_name in array array['workspace_roles','workspace_role_versions','workspace_skill_versions','agent_config_state','agent_config_revisions','agent_config_events'] loop
  execute format('alter table public.%I enable row level security',table_name);
  execute format('alter table public.%I force row level security',table_name);
  execute format('drop policy if exists owner_configuration_select on public.%I',table_name);
  execute format('create policy owner_configuration_select on public.%I for select to authenticated using (exists(select 1 from public.workspaces w where w.id=workspace_id and w.owner_id=auth.uid()))',table_name);
  -- Browser writes cannot bypass compare-and-swap or immutable version history.
  execute format('revoke all on public.%I from anon, authenticated',table_name);
  execute format('grant select on public.%I to authenticated',table_name);
  execute format('grant all on public.%I to service_role',table_name);
 end loop;
end $$;
create or replace function public.assert_configuration_owner(p_workspace_id uuid,p_owner_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from public.workspaces w where w.id=p_workspace_id and w.owner_id=p_owner_id) then
  raise exception 'CONFIGURATION_FORBIDDEN' using errcode='42501';
 end if;
end $$;
-- Validate custom references at the database boundary as well as in the API.
create or replace function public.assert_configuration_references(p_workspace_id uuid,p_configuration jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r jsonb; s jsonb;
begin
 r:=p_configuration->'role';
 if r->>'kind'='custom' and not exists(select 1 from public.workspace_role_versions v where v.workspace_id=p_workspace_id and v.role_id=(r->>'id')::uuid and v.version=(r->>'version')::integer) then
  raise exception 'CONFIGURATION_REFERENCE_NOT_FOUND' using errcode='22023';
 end if;
 for s in select value from jsonb_array_elements(coalesce(p_configuration->'skills','[]')) loop
  if s->>'source'='custom' and not exists(select 1 from public.workspace_skill_versions v where v.workspace_id=p_workspace_id and v.skill_id=(s->>'id')::uuid and v.version=(s->>'version')::integer) then
   raise exception 'CONFIGURATION_REFERENCE_NOT_FOUND' using errcode='22023';
  end if;
 end loop;
end $$;
create or replace function public.save_agent_configuration(
 p_workspace_id uuid,p_owner_id uuid,p_agent_id uuid,p_base_revision integer,p_configuration jsonb,p_resolved_bundle jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_state public.agent_config_state%rowtype; next_revision integer;
begin
 perform public.assert_configuration_owner(p_workspace_id,p_owner_id);
 perform 1 from public.agents a where a.id=p_agent_id and a.workspace_id=p_workspace_id and a.status<>'revoked' for share;
 if not found then raise exception 'CONFIGURATION_AGENT_NOT_FOUND' using errcode='P0002'; end if;
 if p_base_revision is null or p_base_revision<0 or jsonb_typeof(p_configuration)<>'object' or jsonb_typeof(p_resolved_bundle)<>'object' then
  raise exception 'CONFIGURATION_INVALID_INPUT' using errcode='22023';
 end if;
 perform public.assert_configuration_references(p_workspace_id,p_configuration);
 insert into public.agent_config_state(agent_id,workspace_id) values(p_agent_id,p_workspace_id) on conflict(agent_id) do nothing;
 select * into current_state from public.agent_config_state where agent_id=p_agent_id and workspace_id=p_workspace_id for update;
 if current_state.desired_revision<>p_base_revision then raise exception 'BASE_REVISION_CONFLICT' using errcode='P0001'; end if;
 next_revision:=current_state.desired_revision+1;
 insert into public.agent_config_revisions(agent_id,workspace_id,revision,configuration,resolved_bundle,created_by)
 values(p_agent_id,p_workspace_id,next_revision,p_configuration,p_resolved_bundle,p_owner_id);
 -- applied_revision is deliberately NEVER changed by Stage A.
 update public.agent_config_state set desired_revision=next_revision,desired_configuration=p_configuration,updated_by=p_owner_id,updated_at=now()
 where agent_id=p_agent_id and workspace_id=p_workspace_id;
 insert into public.agent_config_events(workspace_id,agent_id,revision,actor_id,event_type,metadata)
 values(p_workspace_id,p_agent_id,next_revision,p_owner_id,'configuration_saved',jsonb_build_object('base_revision',p_base_revision));
 return jsonb_build_object('desired_revision',next_revision,'applied_revision',current_state.applied_revision,'configuration',p_configuration,'updated_at',now());
end $$;
create or replace function public.save_workspace_role(
 p_workspace_id uuid,p_owner_id uuid,p_role_id uuid,p_base_version integer,p_definition jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare role_id uuid:=coalesce(p_role_id,gen_random_uuid()); stored_role public.workspace_roles%rowtype; next_version integer;
begin
 perform public.assert_configuration_owner(p_workspace_id,p_owner_id);
 perform public.assert_configuration_references(p_workspace_id,p_definition);
 if p_role_id is null then
  next_version:=1;
  insert into public.workspace_roles(id,workspace_id,name,description,created_by)
  values(role_id,p_workspace_id,p_definition->>'name',p_definition->>'description',p_owner_id);
 else
  select * into stored_role from public.workspace_roles r where r.id=p_role_id and r.workspace_id=p_workspace_id for update;
  if not found then raise exception 'CONFIGURATION_ROLE_NOT_FOUND' using errcode='P0002'; end if;
  if p_base_version is null or stored_role.current_version<>p_base_version then raise exception 'BASE_VERSION_CONFLICT' using errcode='P0001'; end if;
  next_version:=stored_role.current_version+1;
  update public.workspace_roles set name=p_definition->>'name',description=p_definition->>'description',current_version=next_version,updated_at=now() where id=role_id;
 end if;
 insert into public.workspace_role_versions(role_id,workspace_id,version,name,description,instructions,skills,permissions,created_by)
 values(role_id,p_workspace_id,next_version,p_definition->>'name',p_definition->>'description',p_definition->>'instructions',p_definition->'skills',p_definition->'permissions',p_owner_id);
 insert into public.agent_config_events(workspace_id,actor_id,event_type,metadata)
 values(p_workspace_id,p_owner_id,case when p_role_id is null then 'role_created' else 'role_version_created' end,jsonb_build_object('role_id',role_id,'version',next_version));
 return jsonb_build_object('id',role_id,'version',next_version);
end $$;
create or replace function public.save_workspace_skill(
 p_workspace_id uuid,p_owner_id uuid,p_skill_id uuid,p_base_version integer,p_name text,p_description text,p_content text,p_sha256 text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare skill_id uuid:=coalesce(p_skill_id,gen_random_uuid()); current_version integer; next_version integer;
begin
 perform public.assert_configuration_owner(p_workspace_id,p_owner_id);
 -- Serializes appends to a skill without permitting mutation of prior content.
 perform pg_advisory_xact_lock(hashtextextended(skill_id::text,0));
 if p_skill_id is null then next_version:=1;
 else
  select max(v.version) into current_version from public.workspace_skill_versions v where v.skill_id=p_skill_id and v.workspace_id=p_workspace_id;
  if current_version is null then raise exception 'CONFIGURATION_SKILL_NOT_FOUND' using errcode='P0002'; end if;
  if p_base_version is null or current_version<>p_base_version then raise exception 'BASE_VERSION_CONFLICT' using errcode='P0001'; end if;
  next_version:=current_version+1;
 end if;
 insert into public.workspace_skill_versions(skill_id,workspace_id,version,name,description,content,sha256,created_by)
 values(skill_id,p_workspace_id,next_version,p_name,p_description,p_content,p_sha256,p_owner_id);
 insert into public.agent_config_events(workspace_id,actor_id,event_type,metadata)
 values(p_workspace_id,p_owner_id,'skill_version_created',jsonb_build_object('skill_id',skill_id,'version',next_version));
 return jsonb_build_object('id',skill_id,'version',next_version);
end $$;
-- RPCs are server-only; a verified session owner is supplied by requireOwner.
revoke all on function public.assert_configuration_owner(uuid,uuid),public.assert_configuration_references(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.save_agent_configuration(uuid,uuid,uuid,integer,jsonb,jsonb),public.save_workspace_role(uuid,uuid,uuid,integer,jsonb),public.save_workspace_skill(uuid,uuid,uuid,integer,text,text,text,text) from public,anon,authenticated;
grant execute on function public.assert_configuration_owner(uuid,uuid),public.assert_configuration_references(uuid,jsonb),public.save_agent_configuration(uuid,uuid,uuid,integer,jsonb,jsonb),public.save_workspace_role(uuid,uuid,uuid,integer,jsonb),public.save_workspace_skill(uuid,uuid,uuid,integer,text,text,text,text) to service_role;
notify pgrst,'reload schema';
commit;
