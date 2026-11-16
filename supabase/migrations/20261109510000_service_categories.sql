-- Editable service categories (#86).
--
-- `services.category` stays the free-text label a service is filed under (1–40 chars), so the
-- booking engine, search, rebook rules and the Vagaro services import (#16) are unchanged.
-- `public.service_categories` is the salon's ordered list of category names:
--
--   * Any service write (save_service, the services import, the starter menu seed) adds its
--     category to the list automatically (trigger below), at the end.
--   * Owners add, rename (every service in it follows), remove/merge and reorder categories
--     through the RPCs below. The services list and the public booking page sort by `position`.
--
-- Names match `services.category` exactly. Writes go through the RPCs so the list and the
-- services never disagree; members can read the list.

create table public.service_categories (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40 and name = btrim(name)),
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_categories_salon_name_key unique (salon_id, name)
);

comment on table public.service_categories is
  'A salon''s service categories in display order. services.category holds the name.';

create index service_categories_salon_position_idx on public.service_categories (salon_id, position);

create trigger service_categories_set_updated_at
  before update on public.service_categories
  for each row execute function private.set_updated_at();

alter table public.service_categories enable row level security;
revoke all on public.service_categories from anon;
revoke insert, update, delete on public.service_categories from authenticated;

create policy "members can read service categories" on public.service_categories
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- Keep the list in step with services
-- ---------------------------------------------------------------------------

create or replace function private.ensure_service_category(p_salon_id uuid, p_name text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.service_categories (salon_id, name, position)
  select p_salon_id, btrim(p_name),
         coalesce((select max(c.position) + 1 from public.service_categories c
                    where c.salon_id = p_salon_id), 0)
  where coalesce(btrim(p_name), '') <> ''
  on conflict (salon_id, name) do nothing;
$$;

create or replace function private.service_category_from_service()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ensure_service_category(new.salon_id, new.category);
  return null;
end;
$$;

create trigger services_ensure_category
  after insert or update of category on public.services
  for each row execute function private.service_category_from_service();

-- Existing salons: the categories their services use, in the order the menu showed them (first
-- service position), then any starter category they don't use yet so the editor still offers it.
insert into public.service_categories (salon_id, name, position)
select salon_id, name, (row_number() over (partition by salon_id order by rank, first_pos, name) - 1)::int
  from (
    select s.salon_id, btrim(s.category) as name, 0 as rank, min(s.position) as first_pos
      from public.services s
     group by s.salon_id, btrim(s.category)
    union all
    select sa.id, st.name, 1, st.ord::int
      from public.salons sa
     cross join unnest(array['Cuts', 'Styling', 'Color', 'Treatments', 'Other'])
                with ordinality st(name, ord)
     where not exists (select 1 from public.services s
                        where s.salon_id = sa.id and btrim(s.category) = st.name)
  ) x
on conflict (salon_id, name) do nothing;

-- ---------------------------------------------------------------------------
-- RPCs (owners only)
-- ---------------------------------------------------------------------------

create or replace function private.assert_service_category_name(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if char_length(coalesce(btrim(p_name), '')) not between 1 and 40 then
    raise exception 'A category name is 1 to 40 characters' using errcode = '22023';
  end if;
  return btrim(p_name);
end;
$$;

create or replace function public.add_service_category(p_salon_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only salon owners can edit categories' using errcode = '42501';
  end if;
  perform private.ensure_service_category(p_salon_id, private.assert_service_category_name(p_name));
end;
$$;

comment on function public.add_service_category(uuid, text) is
  'Adds a category at the end of the list (no-op if it exists). Owners only.';

-- Renames a category and every service in it. Renaming onto another existing category merges
-- the two (its services move, the old entry goes).
create or replace function public.rename_service_category(p_salon_id uuid, p_from text, p_to text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to text := private.assert_service_category_name(p_to);
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only salon owners can edit categories' using errcode = '42501';
  end if;
  if p_from is not distinct from v_to then
    return;
  end if;

  if exists (select 1 from public.service_categories
              where salon_id = p_salon_id and name = v_to) then
    delete from public.service_categories where salon_id = p_salon_id and name = p_from;
  else
    update public.service_categories set name = v_to
     where salon_id = p_salon_id and name = p_from;
    if not found then
      perform private.ensure_service_category(p_salon_id, v_to);
    end if;
  end if;
  update public.services set category = v_to where salon_id = p_salon_id and category = p_from;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, auth.uid(), 'service_category.renamed', 'service_category', v_to,
          jsonb_build_object('from', p_from, 'to', v_to));
end;
$$;

comment on function public.rename_service_category(uuid, text, text) is
  'Renames a category and moves its services (merges when the new name exists). Owners only.';

-- Removes a category. One that still has services (archived ones included) needs p_move_to:
-- its services move there first (a merge).
create or replace function public.delete_service_category(
  p_salon_id uuid,
  p_name     text,
  p_move_to  text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to text;
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only salon owners can edit categories' using errcode = '42501';
  end if;
  if exists (select 1 from public.services where salon_id = p_salon_id and category = p_name) then
    if p_move_to is null then
      raise exception 'Move this category''s services to another category first'
        using errcode = '23503';
    end if;
    v_to := private.assert_service_category_name(p_move_to);
    if v_to = p_name then
      raise exception 'Pick a different category to move the services to' using errcode = '22023';
    end if;
    perform private.ensure_service_category(p_salon_id, v_to);
    update public.services set category = v_to where salon_id = p_salon_id and category = p_name;
  end if;
  delete from public.service_categories where salon_id = p_salon_id and name = p_name;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, auth.uid(), 'service_category.removed', 'service_category', p_name,
          jsonb_build_object('moved_to', v_to));
end;
$$;

comment on function public.delete_service_category(uuid, text, text) is
  'Removes a category; one with services needs p_move_to (its services move there). Owners only.';

-- Sets the display order. Names listed come first in that order; any not listed keep their
-- relative order after them. Unknown names are ignored.
create or replace function public.reorder_service_categories(p_salon_id uuid, p_names text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only salon owners can edit categories' using errcode = '42501';
  end if;
  update public.service_categories c
     set position = o.pos
    from (
      select c2.id,
             (row_number() over (order by array_position(p_names, c2.name) nulls last,
                                          c2.position, c2.name) - 1)::int as pos
        from public.service_categories c2
       where c2.salon_id = p_salon_id
    ) o
   where c.id = o.id and c.position is distinct from o.pos;
end;
$$;

comment on function public.reorder_service_categories(uuid, text[]) is
  'Sets the category display order (services list, public booking page). Owners only.';

revoke all on function private.ensure_service_category(uuid, text) from public;
revoke all on function private.service_category_from_service() from public;
revoke all on function private.assert_service_category_name(text) from public;
revoke all on function public.add_service_category(uuid, text) from public, anon;
revoke all on function public.rename_service_category(uuid, text, text) from public, anon;
revoke all on function public.delete_service_category(uuid, text, text) from public, anon;
revoke all on function public.reorder_service_categories(uuid, text[]) from public, anon;
grant execute on function public.add_service_category(uuid, text) to authenticated;
grant execute on function public.rename_service_category(uuid, text, text) to authenticated;
grant execute on function public.delete_service_category(uuid, text, text) to authenticated;
grant execute on function public.reorder_service_categories(uuid, text[]) to authenticated;

-- Full data export (#46).
select private.register_data_export('service_categories');
