create table if not exists public.signals (
  signal_key text primary key,
  fingerprint text not null,
  symbol text not null,
  strategy_id text not null,
  strategy_name text not null,
  direction text not null default 'NEUTRAL',
  regime text not null default '',
  status text not null default 'LIVE_SIGNAL',
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

alter table public.signals enable row level security;

create index if not exists signals_updated_at_idx on public.signals (updated_at desc);
