import { useEffect, useRef, useState } from "react";

import {
  MAX_GOAL_RUN_MAX_TURNS,
  MIN_GOAL_RUN_MAX_TURNS,
} from "../../shared/group-goal-run";
import { goalRunMaxTurnsSetting, parseGoalRunMaxTurns } from "@/lib/goal-run-turn-limit";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";

export function GoalRunTurnLimitSettings() {
  const { state, dispatch } = useStore();
  const confirmedMaxTurns = goalRunMaxTurnsSetting(state.config);
  const [value, setValue] = useState(String(confirmedMaxTurns));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!dirty) setValue(String(confirmedMaxTurns));
  }, [confirmedMaxTurns, dirty]);

  const save = async () => {
    if (!dirty || saveInFlight.current) return;
    const parsed = parseGoalRunMaxTurns(value);
    if (!parsed.ok) {
      setError(t("settings.goalRuns.range"));
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ goalRuns: { maxTurns: parsed.maxTurns } }),
      });
      dispatch({ type: "configStatus", config });
      setValue(String(goalRunMaxTurnsSetting(config)));
      setDirty(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.goalRuns.error"));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="goal-run-max-turns" className="text-[13px] font-medium text-ink">
        {t("settings.goalRuns.label")}
      </label>
      <div
        className={`flex max-w-[220px] items-center rounded-lg border bg-inset ${
          error ? "border-danger/60" : "border-hairline/40 focus-within:border-focus"
        }`}
      >
        <input
          id="goal-run-max-turns"
          type="number"
          min={MIN_GOAL_RUN_MAX_TURNS}
          max={MAX_GOAL_RUN_MAX_TURNS}
          step={2}
          inputMode="numeric"
          value={value}
          disabled={saving || !state.config?.goalRuns}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "goal-run-max-turns-error goal-run-max-turns-help" : "goal-run-max-turns-help"}
          onChange={(event) => {
            setValue(event.target.value);
            setDirty(true);
            setError("");
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[14px] tabular-nums text-ink focus:outline-none"
        />
        <span className="pr-3 text-[13px] text-ink-secondary">{t("settings.goalRuns.turns")}</span>
      </div>
      <p id="goal-run-max-turns-help" className="text-[12px] leading-relaxed text-ink-secondary">
        {t("settings.goalRuns.help")}
      </p>
      {error ? (
        <p id="goal-run-max-turns-error" role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
