-- AI provider settings: keys live in Vault and are never readable by salon members.
begin;
select plan(30);

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;

create function pg_temp.as_service_role() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
$$;

create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-b000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@ai-a.test'),
  ('00000000-0000-4000-b000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@ai-a.test'),
  ('00000000-0000-4000-b000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@ai-b.test');

select pg_temp.login('00000000-0000-4000-b000-00000000000a');
select public.create_salon('AI Salon A', 'ai-salon-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-b000-00000000000b');
select public.create_salon('AI Salon B', 'ai-salon-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'ai-salon-a') as a,
         (select id from public.salons where slug = 'ai-salon-b') as b;
grant select on ids to authenticated, service_role;

insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-b000-0000000000a2', 'stylist' from ids;

-- Owner A saves a key ----------------------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-00000000000a');

select throws_ok(
  $$ select public.save_ai_provider_config((select a from ids), 'openai', 'gpt-4.1-mini', 500000) $$,
  '22023', 'An API key is required', 'first save requires a key');

select throws_ok(
  $$ select public.save_ai_provider_config((select a from ids), 'openai', 'gpt-4.1-mini', 500000, 'sk-short') $$,
  '22023', 'That does not look like an API key', 'rejects implausible keys');

select is(
  (select key_hint from public.save_ai_provider_config(
     (select a from ids), 'openai', 'gpt-4.1-mini', 500000, 'sk-test-AAAA-secret-value-0001')),
  'sk-…0001', 'owner saves settings; only a hint is returned');

select is(
  (select to_jsonb(c)::text like '%secret-value%' from public.ai_provider_config c, ids where c.salon_id = ids.a),
  false, 'the config row never contains the key');

select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'ai_provider_config'
     and column_name ~ '(api_key|secret)'),
  0, 'ai_provider_config has no key or secret-id column');

select throws_ok(
  $$ select * from public.get_ai_provider_secret((select a from ids)) $$,
  '42501', null, 'even the owner cannot read the decrypted key');

select pg_temp.logout();

-- Stylist (member of A) --------------------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-0000000000a2');

select is(
  (select provider::text || '/' || model || '/' || key_hint from public.ai_provider_config c, ids where c.salon_id = ids.a),
  'openai/gpt-4.1-mini/sk-…0001', 'member can read provider, model and key hint');

select throws_ok(
  $$ select * from public.get_ai_provider_secret((select a from ids)) $$,
  '42501', null, 'member cannot call get_ai_provider_secret');

select throws_ok(
  $$ select * from private.ai_provider_secrets $$,
  '42501', null, 'member cannot select the vault secret mapping');

select throws_ok(
  $$ select decrypted_secret from vault.decrypted_secrets $$,
  '42501', null, 'member cannot select vault.decrypted_secrets');

select throws_ok(
  $$ select secret from vault.secrets $$,
  '42501', null, 'member cannot select vault.secrets');

select throws_ok(
  $$ select public.save_ai_provider_config((select a from ids), 'openai', 'gpt-4.1', 1, 'sk-test-BBBB-stylist-attempt-01') $$,
  '42501', 'Only salon owners can change AI settings', 'stylist cannot change AI settings');

select throws_ok(
  $$ update public.ai_provider_config set monthly_token_budget = 999999999 $$,
  '42501', null, 'members cannot write the config table directly');

select throws_ok(
  $$ insert into public.ai_usage (salon_id, provider, model, input_tokens, output_tokens)
     select a, 'openai', 'x', 0, 0 from ids $$,
  '42501', null, 'members cannot write usage rows (only the Edge Function can)');

select pg_temp.logout();

-- Other salon -----------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-00000000000b');
select is((select count(*)::int from public.ai_provider_config), 0, 'owner B cannot see salon A AI config');
select throws_ok(
  $$ select public.save_ai_provider_config((select a from ids), 'gemini', 'gemini-2.5-flash', 1, 'AIzaTest-owner-b-hijack-000001') $$,
  '42501', 'Only salon owners can change AI settings', 'owner B cannot change salon A settings');
select pg_temp.logout();

-- anon -------------------------------------------------------------------------
set local role anon;
select throws_ok(
  $$ select * from public.get_ai_provider_secret('00000000-0000-0000-0000-000000000000') $$,
  '42501', null, 'anon cannot call get_ai_provider_secret');
select throws_ok(
  $$ select public.save_ai_provider_config('00000000-0000-0000-0000-000000000000', 'openai', 'm', 1, 'sk-test-anon-attempt-00000001') $$,
  '42501', null, 'anon cannot save AI settings');
reset role;

-- Service role (the ai Edge Function) -------------------------------------------
select pg_temp.as_service_role();
select is(
  (select api_key from public.get_ai_provider_secret((select a from ids))),
  'sk-test-AAAA-secret-value-0001', 'service role can read the decrypted key');
insert into public.ai_usage (salon_id, user_id, provider, model, purpose, input_tokens, output_tokens)
  select a, '00000000-0000-4000-b000-0000000000a2'::uuid, 'openai'::public.ai_provider, 'gpt-4.1-mini', 'chat', 100, 20 from ids
  union all
  select a, null, 'openai', 'gpt-4.1-mini', 'connection_test', 5, 1 from ids;
insert into public.ai_usage (salon_id, provider, model, input_tokens, output_tokens, created_at)
  select a, 'openai', 'gpt-4.1-mini', 1000, 1000, now() - interval '40 days' from ids;
select is(public.ai_tokens_used_this_month((select a from ids)), 126::bigint,
  'usage this month sums input + output tokens and ignores earlier months');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-b000-0000000000a2');
select is((select count(*)::int from public.ai_usage), 3, 'members can read their salon usage');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-b000-00000000000b');
select is(public.ai_tokens_used_this_month((select a from ids)), 0::bigint, 'other salons see no usage');
select pg_temp.logout();

-- Updating without a key keeps it; switching providers needs a new key ----------
select pg_temp.login('00000000-0000-4000-b000-00000000000a');
select is(
  (select model || '/' || key_hint from public.save_ai_provider_config((select a from ids), 'openai', 'gpt-4.1', 750000)),
  'gpt-4.1/sk-…0001', 'model/budget change keeps the saved key');
select throws_ok(
  $$ select public.save_ai_provider_config((select a from ids), 'anthropic', 'claude-haiku-4-5', 750000) $$,
  '22023', 'Paste a anthropic API key to switch providers', 'switching providers requires a new key');
select lives_ok(
  $$ select public.save_ai_provider_config((select a from ids), 'anthropic', 'claude-haiku-4-5', 750000, 'sk-ant-test-CCCC-rotated-0002') $$,
  'switch provider with a new key');
select pg_temp.logout();

select is(
  (select api_key from public.get_ai_provider_secret((select a from ids))),
  'sk-ant-test-CCCC-rotated-0002', 'the new key replaced the old one in Vault');
select is(
  (select count(*)::int from vault.secrets where name = 'ai_api_key:' || (select a from ids)),
  1, 'rotating a key reuses one Vault secret');
select is(
  (select count(*)::int from public.audit_log l, ids
   where l.salon_id = ids.a and l.action = 'ai.config_saved' and l.details::text not like '%sk-%'),
  3, 'saves are audited without the key');

-- Deleting removes the Vault secret ---------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-00000000000a');
select lives_ok($$ select public.delete_ai_provider_config((select a from ids)) $$, 'owner can remove AI settings');
select pg_temp.logout();
select is(
  (select count(*)::int from vault.secrets where name = 'ai_api_key:' || (select a from ids)),
  0, 'removing settings destroys the Vault secret');

select * from finish();
rollback;
