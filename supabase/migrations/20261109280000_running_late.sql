-- "Running late" cascade (docs/PLAN.md §11b, issue #37).
--
-- The app (or Ask Chairside) computes the new times with `planRunningLate` in @chairside/core and
-- sends the shifted segments here. Moving several back-to-back appointments one at a time would
-- trip the busy-time exclusion constraint part-way through (A moves onto B before B moves), so this
-- RPC moves them all in one transaction: it clears every moved appointment's segments first, then
-- writes the new ones. The exclusion constraint still checks the final state.

create or replace function public.apply_running_late(
  p_salon_id      uuid,
  p_delay_minutes integer,
  p_moves         jsonb,
  p_strategy      text default null
)
returns setof public.appointments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_move  jsonb;
  v_ids   uuid[];
  v_appt  public.appointments;
  v_from  jsonb := '{}'::jsonb;
  v_count integer;
begin
  if not private.can_book_for_salon(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if p_delay_minutes is null or p_delay_minutes not between 1 and 240 then
    raise exception 'Delay must be 1 to 240 minutes' using errcode = '22023';
  end if;
  if p_strategy is not null and p_strategy not in ('ripple', 'shift_all', 'move_one') then
    raise exception 'Unknown strategy %', p_strategy using errcode = '22023';
  end if;
  if p_moves is null or jsonb_typeof(p_moves) <> 'array'
     or jsonb_array_length(p_moves) not between 1 and 50 then
    raise exception 'Send 1 to 50 moves' using errcode = '22023';
  end if;

  for v_move in select value from jsonb_array_elements(p_moves) loop
    if jsonb_typeof(v_move) <> 'object'
       or coalesce(v_move ->> 'appointmentId', '') !~* '^[0-9a-f-]{36}$'
       or jsonb_typeof(v_move -> 'segments') is distinct from 'array'
    then
      raise exception 'Invalid move: %', v_move using errcode = '22023';
    end if;
    -- Validates order/overlap/length before anything is touched.
    perform private.appointment_segments_span(v_move -> 'segments');
  end loop;

  select array_agg(distinct (e ->> 'appointmentId')::uuid) into v_ids
    from jsonb_array_elements(p_moves) e;
  if cardinality(v_ids) <> jsonb_array_length(p_moves) then
    raise exception 'Each appointment can only move once' using errcode = '22023';
  end if;

  -- Lock in a stable order so two concurrent cascades can't deadlock.
  v_count := 0;
  for v_appt in
    select * from public.appointments a
     where a.id = any (v_ids)
     order by a.id
       for update
  loop
    if v_appt.salon_id <> p_salon_id then
      raise exception 'Appointment not found' using errcode = 'P0002';
    end if;
    if v_appt.status not in ('held', 'requested', 'confirmed') then
      raise exception 'Only upcoming appointments can be moved' using errcode = '22023';
    end if;
    v_from := v_from || jsonb_build_object(v_appt.id::text, v_appt.starts_at);
    v_count := v_count + 1;
  end loop;
  if v_count <> cardinality(v_ids) then
    raise exception 'Appointment not found' using errcode = 'P0002';
  end if;

  begin
    delete from public.appointment_segments where appointment_id = any (v_ids);
    for v_move in select value from jsonb_array_elements(p_moves) loop
      perform private.write_appointment_segments(
        (v_move ->> 'appointmentId')::uuid, v_move -> 'segments');
    end loop;
  exception when exclusion_violation then
    perform private.raise_booking_conflict();
  end;

  for v_appt in select * from public.appointments a where a.id = any (v_ids) order by a.starts_at loop
    insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
    values (p_salon_id, auth.uid(), 'appointment.rescheduled', 'appointment', v_appt.id::text,
            jsonb_build_object('from', v_from -> v_appt.id::text, 'to', v_appt.starts_at,
                               'services_changed', false, 'reason', 'running_late'));
    return next v_appt;
  end loop;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, auth.uid(), 'appointment.running_late', 'salon', p_salon_id::text,
          jsonb_build_object('delay_minutes', p_delay_minutes, 'strategy', p_strategy,
                             'appointment_ids', to_jsonb(v_ids)));
end;
$$;

comment on function public.apply_running_late is
  'Moves several appointments at once for a "running late" cascade planned by @chairside/core.';

revoke all on function public.apply_running_late(uuid, integer, jsonb, text) from public, anon;
grant execute on function public.apply_running_late(uuid, integer, jsonb, text)
  to authenticated, service_role;
