-- Work hours (docs/PLAN.md §5, issue #3).
--
-- Shapes mirror the availability engine's input (packages/core/src/availability/types.ts):
--   blocks: [{ "start": "HH:MM", "end": "HH:MM", "type": "open" | "tentative" | "closed" }]
--   breaks: [{ "start": "HH:MM", "end": "HH:MM" }]
-- Times are wall-clock in the salon's timezone (salons.timezone); `24:00` is allowed as an end.
-- packages/core/src/hours turns these rows into `WorkHours` and resolves any date.

-- ---------------------------------------------------------------------------
-- Validation helpers
-- ---------------------------------------------------------------------------

create or replace function private.is_valid_hours_ranges(p_ranges jsonb, p_typed boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_range jsonb;
begin
  if p_ranges is null or jsonb_typeof(p_ranges) <> 'array' or jsonb_array_length(p_ranges) > 24 then
    return false;
  end if;

  for v_range in select value from jsonb_array_elements(p_ranges) loop
    if jsonb_typeof(v_range) <> 'object'
       or jsonb_typeof(v_range -> 'start') is distinct from 'string'
       or jsonb_typeof(v_range -> 'end') is distinct from 'string'
       or (v_range ->> 'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (v_range ->> 'end') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
       -- Zero-padded HH:MM compares correctly as text.
       or (v_range ->> 'end') <= (v_range ->> 'start')
    then
      return false;
    end if;

    if p_typed then
      if (v_range ->> 'type') is null
         or (v_range ->> 'type') not in ('open', 'tentative', 'closed')
         or exists (select 1 from jsonb_object_keys(v_range) k where k not in ('start', 'end', 'type'))
      then
        return false;
      end if;
    elsif exists (select 1 from jsonb_object_keys(v_range) k where k not in ('start', 'end')) then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

grant execute on function private.is_valid_hours_ranges(jsonb, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- work_hours_template: the blanket weekly schedule. Missing weekday = closed.
-- ---------------------------------------------------------------------------

create table public.work_hours_template (
  salon_id   uuid not null references public.salons (id) on delete cascade,
  weekday    smallint not null check (weekday between 0 and 6),
  blocks     jsonb not null default '[]'::jsonb check (private.is_valid_hours_ranges(blocks, true)),
  breaks     jsonb not null default '[]'::jsonb check (private.is_valid_hours_ranges(breaks, false)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (salon_id, weekday)
);

comment on table public.work_hours_template is
  'Weekly hours template. weekday: 0 = Sunday … 6 = Saturday. No row or no blocks = closed.';

create trigger work_hours_template_set_updated_at
  before update on public.work_hours_template
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- work_hours_override: a single date or inclusive range that replaces the template.
-- ---------------------------------------------------------------------------

create type public.work_hours_override_kind as enum ('custom', 'day_off', 'vacation');

create table public.work_hours_override (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  start_date date not null,
  end_date   date not null,
  kind       public.work_hours_override_kind not null default 'custom',
  blocks     jsonb not null default '[]'::jsonb check (private.is_valid_hours_ranges(blocks, true)),
  breaks     jsonb not null default '[]'::jsonb check (private.is_valid_hours_ranges(breaks, false)),
  note       text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_hours_override_range_order check (end_date >= start_date),
  constraint work_hours_override_range_length check (end_date - start_date < 366),
  constraint work_hours_override_closed_has_no_blocks
    check (kind = 'custom' or (blocks = '[]'::jsonb and breaks = '[]'::jsonb)),
  constraint work_hours_override_unique_range unique (salon_id, start_date, end_date)
);

comment on table public.work_hours_override is
  'Date overrides beat the template. When ranges overlap, the shorter range wins, then the most '
  'recently updated (see packages/core/src/hours).';

create index work_hours_override_salon_end_idx on public.work_hours_override (salon_id, end_date);

create trigger work_hours_override_set_updated_at
  before update on public.work_hours_override
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Booking rules (settings already has booking_window_days, default 60).
-- ---------------------------------------------------------------------------

alter table public.settings
  add column min_notice_minutes integer not null default 120
    check (min_notice_minutes between 0 and 10080),
  add column slot_grid_minutes integer not null default 15
    check (slot_grid_minutes in (5, 10, 15, 20, 30, 60));

comment on column public.settings.min_notice_minutes is 'Lead time: slots must start at least this far from now.';
comment on column public.settings.booking_window_days is 'Max booking window: how far ahead clients can book.';
comment on column public.settings.slot_grid_minutes is 'Local wall-clock grid for offered start times.';

-- ---------------------------------------------------------------------------
-- Row level security: members read, owners write.
-- ---------------------------------------------------------------------------

alter table public.work_hours_template enable row level security;
alter table public.work_hours_override enable row level security;

revoke all on public.work_hours_template, public.work_hours_override from anon;

create policy "members can read work hours template" on public.work_hours_template
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners can add work hours template" on public.work_hours_template
  for insert to authenticated with check (private.has_salon_role(salon_id, 'owner'));
create policy "owners can update work hours template" on public.work_hours_template
  for update to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));
create policy "owners can delete work hours template" on public.work_hours_template
  for delete to authenticated using (private.has_salon_role(salon_id, 'owner'));

create policy "members can read work hours overrides" on public.work_hours_override
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners can add work hours overrides" on public.work_hours_override
  for insert to authenticated with check (private.has_salon_role(salon_id, 'owner'));
create policy "owners can update work hours overrides" on public.work_hours_override
  for update to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));
create policy "owners can delete work hours overrides" on public.work_hours_override
  for delete to authenticated using (private.has_salon_role(salon_id, 'owner'));
