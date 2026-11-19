-- Stage B Part 1: service-only, transactional acknowledgements of desired revisions.
begin;
alter table public.agent_config_state
 add column if not exists sync_revision integer not null default 0,
 add column if not exists sync_status text not null default 'unconfigured',
 add column if not exists sync_error text,
 add column if not exists sync_updated_at timestamptz;
alter table public.agent_config_state drop constraint if exists agent_config_state_sync_status_check;
alter table public.agent_config_state add constraint agent_config_state_sync_status_check
 check(sync_status in ('unconfigured','pending','staged','applied','failed'));
alter table public.agent_config_state drop constraint if exists agent_config_state_sync_revision_check;
alter table public.agent_config_state add constraint agent_config_state_sync_revision_check
 check(sync_revision>=0 and sync_revision<=desired_revision);
alter table public.agent_config_state drop constraint if exists agent_config_state_sync_error_check;
alter table public.agent_config_state add constraint agent_config_state_sync_error_check check(sync_error is null or length(sync_error)<=2000);
-- A bridge is an actor, but is not an auth.users owner identity.
alter table public.agent_config_events alter column actor_id drop not null;
alter table public.agent_config_events drop constraint if exists agent_config_events_event_type_check;
alter table public.agent_config_events add constraint agent_config_events_event_type_check
 check(event_type in ('configuration_saved','role_created','role_version_created','skill_version_created','configuration_staged','configuration_applied','configuration_failed'));
alter table public.agent_config_events drop constraint if exists agent_config_events_actor_check;
alter table public.agent_config_events add constraint agent_config_events_actor_check
 check(actor_id is not null or (agent_id is not null and revision is not null and event_type in ('configuration_staged','configuration_applied','configuration_failed')));

-- Serialize saves and ACKs on the same state row without changing the Stage A CAS RPC.
-- A newer desired revision resets the badge but preserves applied_revision/history.
create or replace function public.reset_agent_configuration_sync() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.desired_revision<>old.desired_revision then
  new.sync_revision:=new.desired_revision;
  new.sync_status:=case when new.desired_revision=0 then 'unconfigured' else 'pending' end;
  new.sync_error:=null; new.sync_updated_at:=null;
 end if;
 return new;
end $$;
drop trigger if exists reset_agent_configuration_sync on public.agent_config_state;
create trigger reset_agent_configuration_sync before update of desired_revision on public.agent_config_state
 for each row execute function public.reset_agent_configuration_sync();
-- Backfill only untouched pre-Stage-B rows. Re-running this migration preserves live ACKs.
update public.agent_config_state set sync_revision=desired_revision,
 sync_status=case when desired_revision=0 then 'unconfigured' when applied_revision=desired_revision then 'applied' else 'pending' end
 where sync_updated_at is null and sync_revision=0 and sync_status='unconfigured';

create or replace function public.ack_agent_configuration(
 p_workspace_id uuid,p_agent_id uuid,p_revision integer,p_status text,p_error text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_state public.agent_config_state%rowtype;
begin
 if p_revision is null or p_revision<1 or p_status is null or p_status not in ('staged','applied','failed') or
    (p_error is not null and (p_status<>'failed' or length(p_error)>2000)) then
  raise exception 'CONFIGURATION_INVALID_ACK' using errcode='22023';
 end if;
 -- Align lock order with save_agent_configuration; revocation cannot slip past an ACK.
 perform 1 from public.agents a where a.id=p_agent_id and a.workspace_id=p_workspace_id and a.status<>'revoked' for share;
 if not found then raise exception 'CONFIGURATION_AGENT_NOT_FOUND' using errcode='42501'; end if;
 select * into current_state from public.agent_config_state where workspace_id=p_workspace_id and agent_id=p_agent_id for update;
 if not found or current_state.desired_revision<>p_revision or not exists(
  select 1 from public.agent_config_revisions r where r.workspace_id=p_workspace_id and r.agent_id=p_agent_id and r.revision=p_revision
 ) then raise exception 'CONFIGURATION_REVISION_CONFLICT' using errcode='P0001'; end if;
 -- At-least-once ACK delivery: replay never adds duplicate events or regresses an applied state.
 if current_state.sync_revision=p_revision and
    (current_state.sync_status='applied' or (current_state.sync_status=p_status and current_state.sync_error is not distinct from p_error)) then
  return jsonb_build_object('revision',p_revision,'status',current_state.sync_status,'applied_revision',current_state.applied_revision);
 end if;
 update public.agent_config_state set sync_revision=p_revision,sync_status=p_status,sync_error=p_error,
  applied_revision=case when p_status='applied' then p_revision else applied_revision end,
  sync_updated_at=now(),updated_at=now()
 where workspace_id=p_workspace_id and agent_id=p_agent_id;
 insert into public.agent_config_events(workspace_id,agent_id,revision,actor_id,event_type,metadata)
 values(p_workspace_id,p_agent_id,p_revision,null,'configuration_'||p_status,
  jsonb_build_object('source','bridge','status',p_status)||case when p_error is null then '{}'::jsonb else jsonb_build_object('error',p_error) end);
 return jsonb_build_object('revision',p_revision,'status',p_status,'applied_revision',case when p_status='applied' then p_revision else current_state.applied_revision end);
end $$;
revoke all on function public.ack_agent_configuration(uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.ack_agent_configuration(uuid,uuid,integer,text,text) to service_role;
revoke all on function public.reset_agent_configuration_sync() from public,anon,authenticated;
grant execute on function public.reset_agent_configuration_sync() to service_role;
commit;
