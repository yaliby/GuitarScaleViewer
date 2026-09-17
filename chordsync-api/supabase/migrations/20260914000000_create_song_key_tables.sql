create extension if not exists pgcrypto;

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 300),
  artist text not null check (char_length(artist) between 1 and 200),
  normalized_title text not null check (char_length(normalized_title) between 1 and 300),
  normalized_artist text not null check (char_length(normalized_artist) between 1 and 200),
  musical_key text check (musical_key is null or musical_key ~ '^[A-G](#|b)?$'),
  mode text check (mode is null or mode in ('major', 'minor')),
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_title, normalized_artist)
);

create table if not exists public.key_suggestions (
  id uuid primary key default gen_random_uuid(),
  song_id uuid not null references public.songs(id) on delete cascade,
  suggested_key text not null check (suggested_key ~ '^[A-G](#|b)?$'),
  suggested_mode text not null check (suggested_mode in ('major', 'minor')),
  suggested_by text not null default 'anonymous' check (char_length(suggested_by) between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists key_suggestions_status_created_at_idx
  on public.key_suggestions (status, created_at);

alter table public.songs enable row level security;
alter table public.key_suggestions enable row level security;

comment on table public.songs is
  'Song metadata and administrator-verified musical keys used by the ChordSync worker.';
comment on table public.key_suggestions is
  'Untrusted key suggestions awaiting administrator review.';
