-- Screen-share signaling for The Conference Room.
-- Members-only. Tables have RLS on with no policies; they are reached only through the
-- security-definer function below, the same pattern as conference_room_api.
-- Video itself never touches the database: it goes browser-to-browser (WebRTC).

create table if not exists public.cr_rtc_peers (
  peer_id text primary key check (peer_id ~ '^[a-z0-9-]{16,64}$'),
  room_id uuid not null references public.cr_rooms(id) on delete cascade,
  participant_hash text not null,
  sharing boolean not null default false,
  seen timestamptz not null default now()
);
create index if not exists cr_rtc_peers_room_idx on public.cr_rtc_peers(room_id, seen);
alter table public.cr_rtc_peers enable row level security;

create table if not exists public.cr_rtc_signals (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.cr_rooms(id) on delete cascade,
  from_peer text not null,
  to_peer text not null,
  body jsonb not null,
  created timestamptz not null default now()
);
create index if not exists cr_rtc_signals_to_idx on public.cr_rtc_signals(to_peer, id);
create index if not exists cr_rtc_signals_created_idx on public.cr_rtc_signals(created);
alter table public.cr_rtc_signals enable row level security;

create or replace function public.conference_room_rtc(p_key text, p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_hash text;
  v_room uuid;
  v_peer text;
  v_to text;
  v_result jsonb;
begin
  if p_key is null or char_length(p_key) < 12 then raise exception 'Invalid ID key'; end if;
  v_hash := encode(extensions.digest(p_key,'sha256'),'hex');
  if not exists (select 1 from public.cr_participants where key_hash = v_hash) then raise exception 'Unknown ID key'; end if;

  v_room := nullif(p_data->>'room_id','')::uuid;
  v_peer := p_data->>'peer';
  if v_room is null or not exists (select 1 from public.cr_members where room_id = v_room and participant_hash = v_hash) then
    raise exception 'Not a room member';
  end if;
  if v_peer is null or v_peer !~ '^[a-z0-9-]{16,64}$' then raise exception 'Invalid peer'; end if;
  -- a peer id always belongs to the participant who first used it
  if exists (select 1 from public.cr_rtc_peers where peer_id = v_peer and participant_hash <> v_hash) then
    raise exception 'Invalid peer';
  end if;

  if p_action = 'presence' then
    insert into public.cr_rtc_peers(peer_id, room_id, participant_hash, sharing, seen)
    values (v_peer, v_room, v_hash, coalesce((p_data->>'sharing')::boolean, false), now())
    on conflict (peer_id) do update set room_id = excluded.room_id, sharing = excluded.sharing, seen = now();
    delete from public.cr_rtc_peers where seen < now() - interval '60 seconds';
    delete from public.cr_rtc_signals where created < now() - interval '2 minutes';
    select coalesce(jsonb_agg(jsonb_build_object('peer', x.peer_id, 'name', p.display_name, 'kind', p.kind, 'sharing', x.sharing)), '[]'::jsonb)
      into v_result
      from public.cr_rtc_peers x join public.cr_participants p on p.key_hash = x.participant_hash
      where x.room_id = v_room and x.peer_id <> v_peer and x.seen > now() - interval '15 seconds';
    return v_result;

  elsif p_action = 'signal' then
    v_to := p_data->>'to';
    if not exists (select 1 from public.cr_rtc_peers where peer_id = v_peer and participant_hash = v_hash and room_id = v_room) then
      raise exception 'Join the room first';
    end if;
    if not exists (select 1 from public.cr_rtc_peers where peer_id = v_to and room_id = v_room and seen > now() - interval '30 seconds') then
      raise exception 'That person has left';
    end if;
    if p_data->'body' is null or jsonb_typeof(p_data->'body') <> 'object' or char_length((p_data->'body')::text) > 30000 then
      raise exception 'Invalid signal';
    end if;
    if (select count(*) from public.cr_rtc_signals where from_peer = v_peer and created > now() - interval '60 seconds') >= 300 then
      raise exception 'Too many signals, slow down';
    end if;
    insert into public.cr_rtc_signals(room_id, from_peer, to_peer, body) values (v_room, v_peer, v_to, p_data->'body');
    return jsonb_build_object('ok', true);

  elsif p_action = 'poll' then
    if not exists (select 1 from public.cr_rtc_peers where peer_id = v_peer and participant_hash = v_hash) then
      return '[]'::jsonb;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'from', s.from_peer, 'body', s.body) order by s.id), '[]'::jsonb)
      into v_result
      from (select * from public.cr_rtc_signals
            where to_peer = v_peer and room_id = v_room and id > coalesce((p_data->>'after')::bigint, 0)
            order by id limit 100) s;
    return v_result;

  elsif p_action = 'leave' then
    delete from public.cr_rtc_peers where peer_id = v_peer and participant_hash = v_hash;
    delete from public.cr_rtc_signals where to_peer = v_peer or from_peer = v_peer;
    return jsonb_build_object('ok', true);
  else
    raise exception 'Unknown action';
  end if;
end;
$function$;

revoke all on function public.conference_room_rtc(text, text, jsonb) from public;
grant execute on function public.conference_room_rtc(text, text, jsonb) to anon, authenticated, service_role;
