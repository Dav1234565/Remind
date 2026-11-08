create table if not exists public.remind_ai_chat_usage (
  installation_id uuid primary key,
  usage_day date not null default current_date,
  request_count integer not null default 0
);

create table if not exists public.remind_ai_global_daily_usage (
  usage_day date primary key,
  request_count integer not null default 0
);

create table if not exists public.remind_ai_hourly_messages (
  slot text primary key,
  message text,
  created_at timestamptz not null default now()
);

alter table public.remind_ai_chat_usage enable row level security;
alter table public.remind_ai_global_daily_usage enable row level security;
alter table public.remind_ai_hourly_messages enable row level security;

revoke all on table public.remind_ai_chat_usage from anon, authenticated;
revoke all on table public.remind_ai_global_daily_usage from anon, authenticated;
revoke all on table public.remind_ai_hourly_messages from anon, authenticated;
grant all on table public.remind_ai_chat_usage to service_role;
grant all on table public.remind_ai_global_daily_usage to service_role;
grant all on table public.remind_ai_hourly_messages to service_role;

create or replace function public.claim_remind_ai_chat_request(p_installation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean;
begin
  insert into public.remind_ai_global_daily_usage (usage_day, request_count)
  values (current_date, 1)
  on conflict (usage_day) do update
    set request_count = public.remind_ai_global_daily_usage.request_count + 1
    where public.remind_ai_global_daily_usage.request_count < 300
  returning true into claimed;

  if not found then
    return false;
  end if;

  insert into public.remind_ai_chat_usage (installation_id, usage_day, request_count)
  values (p_installation_id, current_date, 1)
  on conflict (installation_id) do update
    set usage_day = current_date,
        request_count = case
          when public.remind_ai_chat_usage.usage_day = current_date
            then public.remind_ai_chat_usage.request_count + 1
          else 1
        end
    where public.remind_ai_chat_usage.usage_day <> current_date
       or public.remind_ai_chat_usage.request_count < 30
  returning true into claimed;

  if not found then
    update public.remind_ai_global_daily_usage
    set request_count = request_count - 1
    where usage_day = current_date;
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.claim_remind_ai_chat_request(uuid) from public, anon, authenticated;
grant execute on function public.claim_remind_ai_chat_request(uuid) to service_role;

create or replace function public.claim_remind_ai_message_slot(p_slot text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.remind_ai_hourly_messages (slot)
  values (p_slot)
  on conflict (slot) do nothing;
  return found;
end;
$$;

revoke all on function public.claim_remind_ai_message_slot(text) from public, anon, authenticated;
grant execute on function public.claim_remind_ai_message_slot(text) to service_role;
