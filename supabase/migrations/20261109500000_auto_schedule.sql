-- Auto-Schedule (#84): book the slot the stylist picked from the suggestions for a text request.
--
-- The inbox edge function ranks openings for a captured request (the model only reads *when*
-- the client can come in; the engine lays out the segments). Tapping one calls this, which ends
-- in the same approval as the Inbox card's Approve button, so deposits and the opt-in auto-send
-- reply behave exactly as they do there:
--   - a reschedule moves the client's existing appointment in place (the slot the pipeline held
--     for the request is released), and the request is approved;
--   - a booking moves the request's hold to the picked time, or books a new `requested`
--     appointment (source 'inbox') for it, then approves it (requested → confirmed). The
--     existing triggers approve the request, hold for a deposit when one is due, and queue the
--     confirmation when auto-send is on. Otherwise the app drafts the reply for the stylist.
create or replace function public.schedule_captured_request(
  p_request_id  uuid,
  p_segments    jsonb,
  p_services    jsonb default null,
  p_price_cents integer default null
)
returns public.appointments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req    public.captured_requests;
  v_appt   public.appointments;
  v_hold   uuid;
  v_target uuid;
begin
  select * into v_req from public.captured_requests where id = p_request_id for update;
  if not found or not private.can_book_for_salon(v_req.salon_id) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request was already handled' using errcode = '22023';
  end if;
  if v_req.intent = 'cancel' then
    raise exception 'A cancellation has nothing to schedule' using errcode = '22023';
  end if;

  select a.id into v_hold from public.appointments a
   where a.id = v_req.appointment_id and a.status in ('held', 'requested');
  if v_req.intent = 'reschedule' then
    select a.id into v_target from public.appointments a
     where a.id = v_req.target_appointment_id and a.status in ('held', 'requested', 'confirmed');
  end if;

  if v_target is not null then
    -- Detach the proposed slot first so cancelling it doesn't decline the request.
    if v_hold is not null then
      update public.captured_requests set appointment_id = null where id = v_req.id;
      perform public.set_appointment_status(v_hold, 'cancelled', 'replaced');
    end if;
    v_appt := public.reschedule_appointment(v_target, p_segments, p_services, p_price_cents);
    -- Approving queues the auto-send confirmation (private.queue_auto_reply) when it's on.
    update public.captured_requests
       set appointment_id = v_target, status = 'approved', resolved_at = now()
     where id = v_req.id;
  else
    if v_hold is not null then
      perform public.reschedule_appointment(v_hold, p_segments, p_services, p_price_cents);
    else
      v_hold := (public.book_appointment(
        v_req.salon_id, v_req.client_id, p_segments, coalesce(p_services, '[]'::jsonb),
        'requested', 'inbox', p_price_cents,
        'Requested by text' || coalesce(': ' || nullif(btrim(v_req.parsed ->> 'notes'), ''), ''),
        null)).id;
      update public.captured_requests set appointment_id = v_hold where id = v_req.id;
    end if;
    -- The Approve path: the status-sync / deposit triggers approve the request.
    v_appt := public.set_appointment_status(v_hold, 'confirmed');
  end if;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_req.salon_id, auth.uid(), 'captured_request.auto_scheduled', 'captured_request',
          v_req.id::text,
          jsonb_build_object('appointment_id', v_appt.id, 'starts_at', v_appt.starts_at,
                             'status', v_appt.status));
  return v_appt;
end;
$$;

comment on function public.schedule_captured_request is
  'Auto-Schedule (#84): books (or moves) the picked slot for a pending text request and approves it.';

revoke all on function public.schedule_captured_request(uuid, jsonb, jsonb, integer)
  from public, anon;
grant execute on function public.schedule_captured_request(uuid, jsonb, jsonb, integer)
  to authenticated, service_role;
