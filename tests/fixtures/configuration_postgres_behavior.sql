-- Transactional fixtures; the runner uses a fresh, private PostgreSQL cluster.
begin;
insert into auth.users(id) values
 ('33333333-3333-4333-8333-333333333333'),
 ('66666666-6666-4666-8666-666666666666');
insert into public.workspaces(id,owner_id,name,agent_invite_hash) values
 ('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','Workspace 1',encode(digest('invite-1','sha256'),'hex')),
 ('22222222-2222-4222-8222-222222222222','66666666-6666-4666-8666-666666666666','Workspace 2',encode(digest('invite-2','sha256'),'hex'));

do $$
declare
 w1 uuid := '11111111-1111-4111-8111-111111111111';
 w2 uuid := '22222222-2222-4222-8222-222222222222';
 o1 uuid := '33333333-3333-4333-8333-333333333333';
 o2 uuid := '66666666-6666-4666-8666-666666666666';
 a1 uuid; a2 uuid; r1 uuid; r2 uuid; s1 uuid; result jsonb;
 definition jsonb := '{"name":"Reusable role","description":"Fixture role.","instructions":"Observe without changes.","skills":[],"permissions":{}}';
 neutral jsonb := '{"role":null,"skills":[],"instructions":"","permissions":{}}';
 configured jsonb;
 content1 text := E'---\nname: local-check\ndescription: Verify a change.\n---\n\n# Check\n\nRun tests.\n';
 content2 text := E'---\nname: local-check\ndescription: Verify a change.\n---\n\n# Check\n\nRun tests and record evidence.\n';
begin
 a1 := (public.register_agent(w1,encode(digest('invite-1','sha256'),'hex'),'Slot 1','unconfigured',encode(digest('key-1','sha256'),'hex'))).id;
 a2 := (public.register_agent(w2,encode(digest('invite-2','sha256'),'hex'),'Slot 2','unconfigured',encode(digest('key-2','sha256'),'hex'))).id;
 if exists(select 1 from public.agent_config_state) or exists(select 1 from public.agent_config_revisions) then
  raise exception 'Registration must not assign configuration or presets';
 end if;

 result := public.save_workspace_role(w1,o1,null,null,definition);
 r1 := (result->>'id')::uuid;
 result := public.save_workspace_role(w1,o1,r1,1,jsonb_set(definition,'{instructions}','"Updated template."'));
 if (result->>'version')::integer <> 2 then raise exception 'Role version did not advance'; end if;
 if (select instructions from public.workspace_role_versions where role_id=r1 and version=1) <> 'Observe without changes.' then
  raise exception 'Role version 1 was overwritten';
 end if;
 begin
  perform public.save_workspace_role(w1,o1,r1,1,definition);
  raise exception 'Expected role CAS rejection';
 exception when sqlstate 'P0001' then
  if sqlerrm <> 'BASE_VERSION_CONFLICT' then raise; end if;
 end;
 r2 := (public.save_workspace_role(w2,o2,null,null,jsonb_set(definition,'{name}','"Other role."'))->>'id')::uuid;

 result := public.save_workspace_skill(w1,o1,null,null,'local-check','Verify a change.',content1,encode(digest(content1,'sha256'),'hex'));
 s1 := (result->>'id')::uuid;
 result := public.save_workspace_skill(w1,o1,s1,1,'local-check','Verify a change.',content2,encode(digest(content2,'sha256'),'hex'));
 if (result->>'version')::integer <> 2 then raise exception 'Skill version did not advance'; end if;
 if (select content from public.workspace_skill_versions where skill_id=s1 and version=1) <> content1 then
  raise exception 'Skill version 1 was overwritten';
 end if;
 begin
  perform public.save_workspace_skill(w1,o1,s1,1,'local-check','Verify a change.',content1,encode(digest(content1,'sha256'),'hex'));
  raise exception 'Expected skill CAS rejection';
 exception when sqlstate 'P0001' then
  if sqlerrm <> 'BASE_VERSION_CONFLICT' then raise; end if;
 end;
 if exists(select 1 from public.agent_config_state) then raise exception 'Saving templates must not configure a linked slot'; end if;

 result := public.save_agent_configuration(w1,o1,a1,0,neutral,neutral);
 if (result->>'desired_revision')::integer <> 1 or (result->>'applied_revision')::integer <> 0 then
  raise exception 'Stage A must save desired state without claiming application';
 end if;
 configured := jsonb_set(neutral,'{role}',jsonb_build_object('kind','custom','id',r1,'version',2));
 configured := jsonb_set(configured,'{skills}',jsonb_build_array(jsonb_build_object('source','custom','id',s1,'version',2,'enabled',true)));
 result := public.save_agent_configuration(w1,o1,a1,1,configured,configured);
 if (result->>'desired_revision')::integer <> 2 or (result->>'applied_revision')::integer <> 0 then raise exception 'Revision or applied state is incorrect'; end if;
 if (select configuration from public.agent_config_revisions where agent_id=a1 and revision=1) <> neutral then raise exception 'Configuration revision 1 was overwritten'; end if;
 begin
  perform public.save_agent_configuration(w1,o1,a1,1,neutral,neutral);
  raise exception 'Expected configuration CAS rejection';
 exception when sqlstate 'P0001' then
  if sqlerrm <> 'BASE_REVISION_CONFLICT' then raise; end if;
 end;
 begin
  perform public.save_agent_configuration(w1,o2,a1,2,neutral,neutral);
  raise exception 'Expected owner rejection';
 exception when insufficient_privilege then null;
 end;
 begin
  perform public.save_agent_configuration(w1,o1,a2,0,neutral,neutral);
  raise exception 'Expected foreign slot rejection';
 exception when no_data_found then null;
 end;
 begin
  perform public.save_agent_configuration(w1,o1,a1,2,jsonb_set(neutral,'{role}',jsonb_build_object('kind','custom','id',r2,'version',1)),neutral);
  raise exception 'Expected foreign role rejection';
 exception when invalid_parameter_value then
  if sqlerrm <> 'CONFIGURATION_REFERENCE_NOT_FOUND' then raise; end if;
 end;
 if (select count(*) from public.agent_config_revisions where agent_id=a1) <> 2 then raise exception 'Rejected writes left configuration revisions'; end if;
 if (select count(*) from public.agent_config_events where agent_id=a1 and event_type='configuration_saved') <> 2 then raise exception 'Configuration audit trail is inconsistent'; end if;
 perform public.save_agent_configuration(w2,o2,a2,0,neutral,neutral);
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
do $$
begin
 if (select count(*) from public.agent_config_state) <> 1 then raise exception 'Owner RLS leaked another workspace state'; end if;
 if (select count(*) from public.agent_config_revisions) <> 2 then raise exception 'Owner RLS leaked another workspace revision'; end if;
 if (select count(*) from public.workspace_role_versions) <> 2 then raise exception 'Owner RLS leaked another role'; end if;
 if exists(select 1 from public.agent_config_events where workspace_id <> '11111111-1111-4111-8111-111111111111') then raise exception 'Audit RLS leaked another workspace'; end if;
 begin
  update public.agent_config_state set desired_revision=999;
  raise exception 'Authenticated direct write was allowed';
 exception when insufficient_privilege then null;
 end;
 begin
  perform public.save_agent_configuration('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',gen_random_uuid(),0,'{}','{}');
  raise exception 'Authenticated RPC execution was allowed';
 exception when insufficient_privilege then null;
 end;
end $$;
select set_config('request.jwt.claim.sub','66666666-6666-4666-8666-666666666666',true);
do $$
begin
 if (select count(*) from public.agent_config_state) <> 1 or (select count(*) from public.agent_config_revisions) <> 1 then raise exception 'Second owner RLS is incorrect'; end if;
 if exists(select 1 from public.workspace_skill_versions) then raise exception 'Custom skill RLS leaked another workspace'; end if;
end $$;
reset role;
set local role anon;
do $$
begin
 begin
  perform 1 from public.agent_config_state;
  raise exception 'Anonymous configuration read was allowed';
 exception when insufficient_privilege then null;
 end;
end $$;
rollback;
select 'Stage A PostgreSQL behavior: PASS' as result;
