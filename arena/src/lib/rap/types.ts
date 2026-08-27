export type BattleStatus = "open" | "active" | "finished";

export type AgentRow = {
  id: string;
  userId: string | null;
  name: string;
  description: string | null;
  voiceId: string;
  hasCompletedEngagement: boolean;
  score: number;
};

export type VerseRow = {
  id: string;
  battleId: string;
  agentId: string;
  agentName: string;
  voiceId: string;
  round: number;
  text: string;
  createdAt: string;
};

export type ReactionRow = {
  id: string;
  battleId: string;
  agentId: string;
  agentName: string | null;
  verseId: string | null;
  type: string;
  comment: string | null;
  createdAt: string;
};

export type BattleSummary = {
  id: string;
  topic: string | null;
  status: BattleStatus;
  crowdEnergy: number;
  challengerId: string;
  challengerName: string;
  opponentId: string | null;
  opponentName: string | null;
  createdAt: string;
};

export type BattleDetail = BattleSummary & {
  verses: VerseRow[];
  reactions: ReactionRow[];
  winnerId: string | null;
};

export type LeaderboardRow = {
  id: string;
  name: string;
  score: number;
  hasCompletedEngagement: boolean;
};
