import { useEffect, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

export function PromptSettings() {
  const { state } = useStore();
  const prompts = state.config?.prompts;
  return (
    <Card title={t("settings.prompts.title")} subtitle={t("settings.prompts.subtitle")}>
      {prompts ? (
        <div className="flex flex-col gap-6">
          <PromptEditor name="bot" confirmed={prompts.bot} />
          <PromptEditor name="opencode" confirmed={prompts.opencode} />
        </div>
      ) : <p className="text-[13px] text-ink-secondary">{t("settings.prompts.unavailable")}</p>}
    </Card>
  );
}

function PromptEditor({ name, confirmed }: { name: "bot" | "opencode"; confirmed: string }) {
  const { dispatch } = useStore();
  const [value, setValue] = useState(confirmed);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const previous = useRef(confirmed);
  const inFlight = useRef(false);
  useEffect(() => {
    if (confirmed !== previous.current && !dirty) setValue(confirmed);
    previous.current = confirmed;
  }, [confirmed, dirty]);
  const isBot = name === "bot";
  const save = async (text: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ prompts: { [name]: text } }) });
      if (!config.prompts) throw new Error(t("settings.prompts.unavailable"));
      dispatch({ type: "configStatus", config });
      setValue(config.prompts[name]);
      setDirty(false);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.prompts.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={`prompt-${name}`} className="text-[14px] font-medium text-ink">{t(isBot ? "settings.prompts.bot" : "settings.prompts.opencode")}</label>
      <p id={`prompt-${name}-help`} className="text-[13px] leading-relaxed text-ink-secondary">{t(isBot ? "settings.prompts.botHelp" : "settings.prompts.opencodeHelp")}</p>
      <textarea id={`prompt-${name}`} aria-describedby={`prompt-${name}-help`} value={value} rows={6} maxLength={12_000} disabled={saving}
        onChange={(event) => { setValue(event.target.value); setDirty(true); setSaved(false); setError(""); }}
        className="min-h-[120px] w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] leading-relaxed text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 disabled:opacity-60" />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-button ui-button-primary" aria-label={t(isBot ? "settings.prompts.saveBot" : "settings.prompts.saveOpenCode")} disabled={saving || !dirty} onClick={() => void save(value)}>{t("common.save")}</button>
        <button type="button" className="ui-button" aria-label={t(isBot ? "settings.prompts.resetBot" : "settings.prompts.resetOpenCode")} disabled={saving} onClick={() => void save("")}>{t("settings.prompts.reset")}</button>
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <p role="status" className="text-[12px] text-success">{saved ? t("common.saved") : ""}</p>
    </div>
  );
}
