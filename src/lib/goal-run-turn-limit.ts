import {
  DEFAULT_GOAL_RUN_MAX_TURNS,
  MAX_GOAL_RUN_MAX_TURNS,
  MIN_GOAL_RUN_MAX_TURNS,
} from "../../shared/group-goal-run";

export const GOAL_RUN_MAX_TURNS_INPUT_ERROR = "Enter an odd whole number from 1 to 999.";

export type GoalRunMaxTurnsInput =
  | { ok: true; maxTurns: number }
  | { ok: false; error: string };

export function parseGoalRunMaxTurns(value: string): GoalRunMaxTurnsInput {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: GOAL_RUN_MAX_TURNS_INPUT_ERROR };
  const maxTurns = Number(trimmed);
  if (maxTurns < MIN_GOAL_RUN_MAX_TURNS || maxTurns > MAX_GOAL_RUN_MAX_TURNS || maxTurns % 2 === 0) {
    return { ok: false, error: GOAL_RUN_MAX_TURNS_INPUT_ERROR };
  }
  return { ok: true, maxTurns };
}

export function goalRunMaxTurnsSetting(config: { goalRuns?: { maxTurns?: number } } | null | undefined): number {
  return config?.goalRuns?.maxTurns ?? DEFAULT_GOAL_RUN_MAX_TURNS;
}
