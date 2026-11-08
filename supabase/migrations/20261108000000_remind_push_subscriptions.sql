create table if not exists public.remind_push_subscriptions (
  id text primary key check (
    id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  subscription jsonb not null,
  timezone text not null,
  site_url text not null,
  last_sent_slot text,
  updated_at timestamptz not null default now()
);

alter table public.remind_push_subscriptions enable row level security;
revoke all on table public.remind_push_subscriptions from anon, authenticated;
grant all on table public.remind_push_subscriptions to service_role;

create or replace function public.claim_remind_push_slot(p_id text, p_slot text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean;
begin
  update public.remind_push_subscriptions
  set last_sent_slot = p_slot
  where id = p_id
    and last_sent_slot is distinct from p_slot;

  claimed := found;
  return claimed;
end;
$$;

revoke all on function public.claim_remind_push_slot(text, text) from public, anon, authenticated;
grant execute on function public.claim_remind_push_slot(text, text) to service_role;
