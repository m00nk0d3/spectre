export interface ConversationMemoryTurn {
  id: string;
  createdAt: string;
  user: string;
  assistant: string;
}

export interface ConversationMemorySummary {
  id: string;
  createdAt: string;
  from: string;
  to: string;
  content: string;
}

export interface ConversationMemorySnapshot {
  enabled: boolean;
  turnCount: number;
  summaryCount: number;
  oldestTurnAt: string | null;
  newestTurnAt: string | null;
  recentTurns: ConversationMemoryTurn[];
}

export interface ConversationMemoryContext {
  text: string;
  turnIds: string[];
  summaryIds: string[];
}
