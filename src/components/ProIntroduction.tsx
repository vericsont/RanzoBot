import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { useStore } from "@/state/store";
import { buyOfferAllowed, cloudPlanLine, cloudPlanView, type CloudPlanView } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { SettingRow } from "./SettingsPrimitives";
import { type UpgradeUi } from "./CloudUsageMeter";
import type { CloudUsage } from "../../electron/cloud-home.mjs";

export function proOfferAvailable(account: CloudAccountState | null): boolean {
  return buyOfferAllowed(cloudPlanView(account));
}

export function useCloudPlan(): { view: CloudPlanView; account: CloudAccountState | null } | null {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return bridge ? { view: cloudPlanView(account), account } : null;
}

export function ProSettingsCard() {
  const { dispatch } = useStore();
  const plan = useCloudPlan();
  if (!plan || buyOfferAllowed(plan.view)) return null;
  const { view } = plan;
  const line = cloudPlanLine(view);
  if (!line && view.kind !== "reauth") return null;
  return <section aria-label={t("settings.section.cloudAccount")} data-cloud-plan={view.kind} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline/50 p-3">
    <div className="flex items-center gap-3">
      <Cloud className="text-ink-secondary" size={18} aria-hidden="true" />
      <div><h3 className="text-[14px] font-semibold text-ink">{t("settings.section.cloudAccount")}</h3>
        <p className="mt-1 text-[12px] text-ink-secondary">{view.kind === "reauth" ? t("pro.reauthShort") : line}</p></div>
    </div>
    <button type="button" className="ui-button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" })}>{t("pro.openCloudSettings")}</button>
  </section>;
}

export function CloudPlanRow({ place }: { place: "account" | "plan"; usage?: CloudUsage | null; upgrade?: UpgradeUi }) {
  const { dispatch } = useStore();
  const plan = useCloudPlan();
  if (!plan || buyOfferAllowed(plan.view)) return null;
  const line = plan.view.kind === "reauth" ? t("pro.reauthShort") : cloudPlanLine(plan.view);
  if (!line) return null;
  return (
    <SettingRow title={t("pro.name")} subtitle={line}>
      {place === "account" ? (
        <button type="button" data-cloud-plan={plan.view.kind} className="ui-button"
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" })}>{t("settings.simple.account.manage")}</button>
      ) : null}
    </SettingRow>
  );
}
