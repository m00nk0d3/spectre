export type GitHubPullRequestEventKind =
  | "opened"
  | "updated"
  | "synchronized"
  | "review_requested"
  | "ready_for_review"
  | "closed"
  | "reopened";

export interface GitHubPullRequestEvent {
  id: string;
  kind: GitHubPullRequestEventKind;
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  state: string;
  headSha: string;
  updatedAt: string;
  detectedAt: string;
}

export interface GitHubMonitorSnapshot {
  status: "idle" | "polling" | "ready" | "error";
  account: string | null;
  repositoryCount: number;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  error: string | null;
  events: GitHubPullRequestEvent[];
}
