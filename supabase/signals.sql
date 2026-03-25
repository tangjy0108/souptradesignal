create table if not exists public.signals (
  signal_key text primary key,
  fingerprint text not null,
  symbol text not null,
  strategy_id text not null,
  strategy_name text not null,
  direction text not null default 'NEUTRAL',
  regime text not null default '',
  status text not null default 'OPEN',
  lifecycle_state text not null default 'LIVE_SIGNAL',
  close_reason text,
  close_outcome text,
  session text,
  setup_type text,
  bias text,
  entry_low double precision not null default 0,
  entry_high double precision not null default 0,
  stop double precision not null default 0,
  target double precision not null default 0,
  rr double precision not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.signals add column if not exists lifecycle_state text not null default 'LIVE_SIGNAL';
alter table public.signals add column if not exists close_reason text;
alter table public.signals add column if not exists close_outcome text;
alter table public.signals alter column status set default 'OPEN';

update public.signals
set
  lifecycle_state = case
    when status in ('WAITING_CONFIRM', 'WAITING_RETEST', 'ACTIVE_TRADE', 'LIVE_SIGNAL') then status
    when status in ('TP_HIT', 'SL_HIT') then coalesce(nullif(lifecycle_state, ''), 'ACTIVE_TRADE')
    else coalesce(nullif(lifecycle_state, ''), 'LIVE_SIGNAL')
  end,
  close_reason = case
    when status = 'TP_HIT' then 'TP'
    when status = 'SL_HIT' then 'SL'
    else close_reason
  end,
  close_outcome = case
    when status = 'TP_HIT' then 'PROFIT'
    when status = 'SL_HIT' then 'LOSS'
    else close_outcome
  end,
  status = case
    when status in ('TP_HIT', 'SL_HIT') then 'CLOSED'
    when status in ('OPEN', 'CLOSED') then status
    else 'OPEN'
  end
where status not in ('OPEN', 'CLOSED')
   or lifecycle_state is null
   or (status = 'CLOSED' and (close_reason is null or close_outcome is null));

alter table public.signals enable row level security;

create index if not exists signals_updated_at_idx on public.signals (updated_at desc);
create index if not exists signals_status_updated_at_idx on public.signals (status, updated_at desc);
create index if not exists signals_strategy_symbol_status_idx on public.signals (strategy_id, symbol, status, updated_at desc);
