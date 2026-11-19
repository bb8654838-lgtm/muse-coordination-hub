-- Assertions run only against the private disposable fixture cluster.
insert into auth.users(id) values
 ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.workspaces(id,name,owner_id,agent_invite_hash) values
 ('10000000-0000-4000-8000-000000000001','Fixture A','00000000-0000-4000-8000-000000000001',encode(digest('fixture-invite-a','sha256'),'hex')),
 ('10000000-0000-4000-8000-000000000002','Fixture B','00000000-0000-4000-8000-000000000002',encode(digest('fixture-invite-b','sha256'),'hex'));
insert into public.agents(id,workspace_id,display_name,role,api_key_hash) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Fixture configured A','reader',encode(digest('fixture-a','sha256'),'hex')),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Fixture configured B','reader',encode(digest('fixture-b','sha256'),'hex')),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','Fixture neutral','reader',encode(digest('fixture-neutral','sha256'),'hex'));
do $$
declare
 w uuid:='10000000-0000-4000-8000-000000000001';
 owner_id uuid:='00000000-0000-4000-8000-000000000001';
 a uuid:='20000000-0000-4000-8000-000000000001';
 neutral uuid:='20000000-0000-4000-8000-000000000003';
 config jsonb:='{"role":null,"skills":[],"instructions":"","permissions":{}}';
 result jsonb; s public.agent_config_state%rowtype; before_count integer;
begin
 begin
  perform public.ack_agent_configuration(w,neutral,1,'staged',null);
  raise exception 'Neutral ACK unexpectedly accepted';
 exception when sqlstate 'P0001' then
  if sqlerrm<>'CONFIGURATION_REVISION_CONFLICT' then raise; end if;
 end;
 if exists(select 1 from public.agent_config_state where agent_id=neutral) then raise exception 'Neutral state was created'; end if;
 result:=public.save_agent_configuration(w,owner_id,a,0,config,config);
 select * into s from public.agent_config_state where agent_id=a;
 if s.desired_revision<>1 or s.applied_revision<>0 or s.sync_status<>'pending' then raise exception 'Initial pending state incorrect'; end if;
 result:=public.ack_agent_configuration(w,a,1,'staged',null);
 if result->>'status'<>'staged' or (result->>'applied_revision')::integer<>0 then raise exception 'Staging applied a revision'; end if;
 perform public.ack_agent_configuration(w,a,1,'failed','Fixture filesystem refusal');
 select * into s from public.agent_config_state where agent_id=a;
 if s.sync_status<>'failed' or s.sync_error<>'Fixture filesystem refusal' or s.applied_revision<>0 then raise exception 'Failure state incorrect'; end if;
 perform public.ack_agent_configuration(w,a,1,'staged',null);
 select * into s from public.agent_config_state where agent_id=a;
 if s.sync_error is not null then raise exception 'Retry did not clear error'; end if;
 perform public.ack_agent_configuration(w,a,1,'applied',null);
 select * into s from public.agent_config_state where agent_id=a;
 if s.applied_revision<>1 or s.sync_revision<>1 or s.sync_status<>'applied' or s.sync_error is not null then raise exception 'Applied state incorrect'; end if;
 select count(*) into before_count from public.agent_config_events where agent_id=a;
 perform public.ack_agent_configuration(w,a,1,'applied',null);
 result:=public.ack_agent_configuration(w,a,1,'staged',null);
 if result->>'status'<>'applied' or (select count(*) from public.agent_config_events where agent_id=a)<>before_count then raise exception 'Duplicate/regressive ACK changed state/events'; end if;
 if exists(select 1 from public.agent_config_events where event_type in ('configuration_staged','configuration_applied','configuration_failed') and (actor_id is not null or metadata->>'source' is distinct from 'bridge' or metadata->>'status' is distinct from replace(event_type,'configuration_',''))) then raise exception 'ACK actor attribution incorrect'; end if;
 begin
  perform public.ack_agent_configuration('10000000-0000-4000-8000-000000000002',a,1,'applied',null);
  raise exception 'Cross-workspace ACK accepted';
 exception when insufficient_privilege then
  if sqlerrm<>'CONFIGURATION_AGENT_NOT_FOUND' then raise; end if;
 end;
 perform public.save_agent_configuration(w,owner_id,a,1,config,config);
 select * into s from public.agent_config_state where agent_id=a;
 if s.desired_revision<>2 or s.applied_revision<>1 or s.sync_status<>'pending' or s.sync_revision<>2 or s.sync_error is not null then raise exception 'New revision reset applied history'; end if;
 begin
  perform public.ack_agent_configuration(w,a,1,'failed','Stale failure');
  raise exception 'Stale ACK accepted';
 exception when sqlstate 'P0001' then
  if sqlerrm<>'CONFIGURATION_REVISION_CONFLICT' then raise; end if;
 end;
 begin
  perform public.ack_agent_configuration(w,a,2,'unknown',null);
  raise exception 'Invalid status accepted';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.ack_agent_configuration(w,a,2,'failed',repeat('x',2001));
  raise exception 'Oversize error accepted';
 exception when invalid_parameter_value then null; end;
 begin
  insert into public.agent_config_events(workspace_id,agent_id,revision,actor_id,event_type) values(w,a,2,null,'configuration_saved');
  raise exception 'Missing owner attribution accepted';
 exception when check_violation then null; end;
 perform public.ack_agent_configuration(w,a,2,'applied',null);
 if not has_function_privilege('service_role','public.ack_agent_configuration(uuid,uuid,integer,text,text)','EXECUTE') or has_function_privilege('anon','public.ack_agent_configuration(uuid,uuid,integer,text,text)','EXECUTE') or has_function_privilege('authenticated','public.ack_agent_configuration(uuid,uuid,integer,text,text)','EXECUTE') then raise exception 'ACK execution ACL incorrect'; end if;
 perform public.save_agent_configuration('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002',0,config,config);
 if exists(select 1 from public.agent_config_state where agent_id=neutral) then raise exception 'Neutral state changed'; end if;
end $$;
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$ begin
 if (select count(*) from public.agent_config_state)<>1 or exists(select 1 from public.agent_config_state where workspace_id='10000000-0000-4000-8000-000000000002') then raise exception 'Owner state RLS leak'; end if;
 if exists(select 1 from public.agent_config_events where workspace_id='10000000-0000-4000-8000-000000000002') then raise exception 'Owner event RLS leak'; end if;
 begin
  perform public.ack_agent_configuration('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',2,'applied',null);
  raise exception 'Browser owner directly executed ACK';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'configuration SQL state, events, isolation, ACL and RLS passed' as result;
