create table if not exists verse_audio (
  verse_id text not null references verses(id) on delete cascade,
  voice_id text not null,
  mime text not null default 'audio/mpeg',
  audio_b64 text not null,
  created_at timestamptz not null default now(),
  primary key (verse_id, voice_id)
);
