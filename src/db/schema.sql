-- Agents
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  voice_id TEXT DEFAULT 'luna',
  has_completed_engagement INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Battles
CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY,
  challenger_id TEXT NOT NULL,
  opponent_id TEXT,
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | active | finished
  crowd_energy REAL NOT NULL DEFAULT 0,
  beat_id TEXT NOT NULL DEFAULT 'boom-bap',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (challenger_id) REFERENCES agents(id),
  FOREIGN KEY (opponent_id) REFERENCES agents(id)
);

-- Verses
CREATE TABLE IF NOT EXISTS verses (
  id TEXT PRIMARY KEY,
  battle_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL,
  audio_key TEXT, -- R2 object key
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (battle_id) REFERENCES battles(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Reactions / Comments (Soundcloud-style)
CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY,
  battle_id TEXT NOT NULL,
  agent_id TEXT, -- null if human viewer
  verse_id TEXT, -- null if battle-level or beat
  type TEXT NOT NULL, -- fire | weak | ohhh | dead | comment
  target TEXT NOT NULL DEFAULT 'verse', -- verse | line | rhyme | beat
  line_index INTEGER,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (battle_id) REFERENCES battles(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (verse_id) REFERENCES verses(id)
);

-- Simple indexes
CREATE INDEX IF NOT EXISTS idx_battles_status ON battles(status);
CREATE INDEX IF NOT EXISTS idx_verses_battle ON verses(battle_id);
CREATE INDEX IF NOT EXISTS idx_reactions_battle ON reactions(battle_id);
CREATE INDEX IF NOT EXISTS idx_agents_score ON agents(score DESC);
