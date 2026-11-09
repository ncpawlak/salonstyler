-- #12 × #10: the client's manage link (/m/<token>) follows the cancellation policy.
--
-- Runs after 20261109350000_client_self_service.sql, which defines the default hook
-- (private.client_change_policy / private.on_client_change); this replaces both.
--
--   view / cancel   a paid deposit is refunded when the client cancels in time and kept as the
--                   cancellation fee (feeCents) inside the window. The link still lets them cancel
--                   late; it tells them the deposit is kept first.
--   reschedule      allowed until it starts; a paid deposit moves with the appointment.
--
-- cancel_booking_by_token cancels through set_appointment_status, whose trigger marks a paid
-- deposit refund_due (salon_cancelled). on_client_change then settles it by the policy the client
-- saw. The manage-booking Edge Function refunds a refund_due deposit through `deposits`.

create or replace function private.client_change_policy(
  p_appointment public.appointments,
  p_action      text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_quote   jsonb;
  v_tz      text;
  v_until   text;
  v_outcome text;
begin
  -- Unchanged from #10.
  if not coalesce((select st.client_self_service_enabled from public.settings st
                    where st.salon_id = p_appointment.salon_id), false) then
    return jsonb_build_object('allowed', false, 'reason', 'disabled', 'feeCents', 0,
      'message', 'Contact the salon to change this appointment.');
  end if;
  if p_appointment.starts_at <= now() then
    return jsonb_build_object('allowed', false, 'reason', 'started', 'feeCents', 0,
      'message', 'This appointment has already started.');
  end if;

  v_quote := private.cancellation_quote(p_appointment.id);
  v_outcome := coalesce(v_quote ->> 'outcome', 'free');
  select s.timezone into v_tz from public.salons s where s.id = p_appointment.salon_id;
  v_until := to_char(((v_quote ->> 'freeUntil')::timestamptz) at time zone coalesce(v_tz, 'UTC'),
                     'Dy FMMon FMDD, FMHH12:MI AM');

  if p_action = 'reschedule' or v_outcome = 'free' then
    return jsonb_build_object('allowed', true, 'feeCents', 0, 'message', null,
      'depositOutcome', v_outcome, 'freeUntil', v_quote ->> 'freeUntil');
  end if;

  if v_outcome = 'keep' then
    return jsonb_build_object('allowed', true,
      'feeCents', coalesce((v_quote ->> 'depositCents')::integer, 0),
      'message', 'Free cancellation ended ' || v_until
                 || '. If you cancel now, the salon keeps your deposit.',
      'depositOutcome', 'keep', 'freeUntil', v_quote ->> 'freeUntil');
  end if;

  return jsonb_build_object('allowed', true, 'feeCents', 0,
    'message', 'Cancel by ' || v_until || ' and your deposit is refunded.',
    'depositOutcome', 'refund', 'freeUntil', v_quote ->> 'freeUntil');
end;
$$;

create or replace function private.on_client_change(
  p_appointment public.appointments,
  p_action      text,
  p_policy      jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_action <> 'cancel' or coalesce(p_policy ->> 'depositOutcome', 'free') = 'free' then
    return;
  end if;

  update public.appointment_deposits d
     set status = case when p_policy ->> 'depositOutcome' = 'keep'
                       then 'kept'::public.deposit_status
                       else 'refund_due'::public.deposit_status end,
         resolution = case when p_policy ->> 'depositOutcome' = 'keep'
                           then 'cancelled_late' else 'cancelled_early' end,
         resolved_at = now()
   where d.appointment_id = p_appointment.id
     and d.status = 'refund_due' and d.resolution = 'salon_cancelled';
end;
$$;

revoke all on function private.client_change_policy(public.appointments, text) from public;
revoke all on function private.on_client_change(public.appointments, text, jsonb) from public;
