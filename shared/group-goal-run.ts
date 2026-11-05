export const DEFAULT_GOAL_RUN_MAX_TURNS = 13;
export const MIN_GOAL_RUN_MAX_TURNS = 1;
export const MAX_GOAL_RUN_MAX_TURNS = 999;

/** Durable progress receipt for one goal-driven channel run. */
export type GroupGoalRunStatus =
  | "working"
  | "completed"
  | "needs-input"
  | "blocked"
  | "limit-reached"
  /** The operator (or a guard) parked the run. */
  | "paused"
  | "stopped"
  | "failed";

export interface GroupGoalRunCardData {
  runId: string;
  goal: string;
  status: GroupGoalRunStatus;
  coordinatorBotId: string;
  coordinatorName: string;
  turnCount: number;
  maxTurns: number;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}
