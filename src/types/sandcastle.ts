export type SandcastleWorkflowStatus =
  | "queued"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed";

export interface SandcastleProject {
  name: string;
  path: string;
  branch: string;
  remote: string | null;
}

export interface SandcastleAgent {
  id: string;
  kind: string;
  name: string;
  status: string;
  summary: string;
  pane_id: string | null;
}

export interface SandcastleStep {
  id: string;
  title: string;
  status: string;
  summary?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface SandcastleWorkflow {
  id: string;
  title: string;
  status: SandcastleWorkflowStatus;
  repo: string;
  worktree_path: string;
  branch: string;
  default_agent: string;
  current_step: string;
  progress: {
    completed: number;
    total: number;
    percent: number;
  };
  github: {
    issue: number | null;
    pull_request: number | null;
  };
  agents: SandcastleAgent[];
  steps: SandcastleStep[];
  started_at: string;
  updated_at: string;
  kind: string;
  pid: number | null;
  source: string;
  error?: string;
}

export interface SandcastleIssuePlan {
  id: string;
  hash: string;
  createdAt: string;
  expiresAt: string;
  project: SandcastleProject;
  issue: number;
  agent: "opencode";
  title: string;
  summary: string;
  effects: string[];
}

export interface SandcastleStartResult {
  workflow: SandcastleWorkflow;
}
