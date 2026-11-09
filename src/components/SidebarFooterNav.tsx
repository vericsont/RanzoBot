import { FolderOpen, Globe, Puzzle, SquareTerminal, UsersRound, Zap } from "lucide-react";
import type { ReactNode } from "react";

import { useAppTriggers } from "@/lib/app-triggers";
import { cn } from "@/lib/cn";
import { useCloudFilesReady } from "@/lib/cloud-files";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useWebPanels } from "@/lib/web-panel-preferences";
import { isRoutineProblemRun } from "@/lib/routines";
import { useSidebarToolsLayout, type SidebarDensity } from "@/lib/sidebar-preferences";
import { useStore } from "@/state/store";

import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { UpdateIndicator } from "./UpdateIndicator";
import type { HostTerminalBridge } from "./TerminalPage";

function hasLocalHostTerminal(): boolean {
  if (typeof window === "undefined") return false;
  const desktop = window.ogb as (NonNullable<typeof window.ogb> & { hostTerminal?: HostTerminalBridge }) | undefined;
  return desktop?.remoteClient?.active !== true && Boolean(desktop?.hostTerminal);
}

function NavRow({
  id,
  label,
  icon,
  active = false,
  attention = false,
  iconsOnly,
  rail = false,
  tourId,
  onClick,
}: {
  id: string;
  label: string;
  icon: (active: boolean) => ReactNode;
  active?: boolean;
  attention?: boolean;
  iconsOnly: boolean;
  rail?: boolean;
  tourId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-tour={tourId}
      data-sidebar-nav={id}
      onClick={onClick}
      aria-label={iconsOnly ? label : undefined}
      title={iconsOnly ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center rounded-xl transition-colors",
        rail ? "size-9 shrink-0 justify-center" : iconsOnly ? "mx-auto size-[46px] shrink-0 justify-center" : "w-full min-h-9 gap-3 px-3 py-1.5 text-left",
        active ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
      )}
    >
      {icon(active)}
      {!iconsOnly && <span className="flex-1 truncate text-[14px] font-medium leading-5">{label}</span>}
      {attention && (
        <span
          data-testid="routines-attention"
          className={cn("size-2 shrink-0 rounded-full bg-danger", iconsOnly && (rail ? "absolute right-1 top-1" : "absolute right-2 top-2"))}
        />
      )}
    </button>
  );
}

export function SidebarTerminalButton({ density, rail = false }: { density: SidebarDensity; rail?: boolean }) {
  const { state, dispatch } = useStore();
  if (!hasLocalHostTerminal()) return null;
  const iconsOnly = density === "icons";
  const iconSize = iconsOnly && !rail ? 20 : 18;
  const label = t("sidebar.nav.terminal");
  return <NavRow
    id="terminal"
    label={label}
    iconsOnly={iconsOnly}
    rail={rail}
    active={state.activeView === "terminal"}
    icon={(active) => <SquareTerminal size={iconSize} className={active ? "text-accent" : "text-ink-secondary"} />}
    onClick={() => dispatch({ type: "showTerminal" })}
  />;
}

export function SidebarAppsButton() {
  const { state, dispatch } = useStore();
  const label = t("sidebar.nav.apps");
  return (
    <button
      type="button"
      data-tour="nav-apps"
      data-sidebar-nav="apps"
      onClick={() => dispatch({ type: "togglePlugins", open: true })}
      aria-label={label}
      title={label}
      aria-pressed={state.pluginsOpen}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors",
        state.pluginsOpen ? "bg-raised text-accent" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
      )}
    >
      <Puzzle size={18} />
    </button>
  );
}

/** An unseen failed run, or an app trigger in trouble. */
export function useAutomationsNeedYou(): boolean {
  const { state } = useStore();
  const appTriggers = useAppTriggers();
  return state.routineRuns.some((run) => isRoutineProblemRun(run) && !run.seenAt) || appTriggers.triggers.some((trigger) => trigger.enabled && trigger.problem);
}

export function SidebarBottomButtons() {
  return (
    <div data-sidebar-bottom-buttons="" className="flex shrink-0 items-center gap-0.5">
      <SidebarAppsButton />
      <UpdateIndicator />
    </div>
  );
}

export function SidebarFooterNav({
  density,
  rail = false,
  collapsed = false,
  onToggleCollapsed,
}: {
  density: SidebarDensity;
  rail?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const webPanels = useWebPanels();
  const iconsOnly = density === "icons";
  const toolsLayout = useSidebarToolsLayout();
  const toolbar = advanced && !iconsOnly && toolsLayout === "toolbar";
  const iconSize = iconsOnly && !rail ? 20 : 18;
  const tone = (active: boolean) => (active ? "text-accent" : "text-ink-secondary");
  const automationsNeedYou = useAutomationsNeedYou();
  const terminalRow = <SidebarTerminalButton density={density} rail={rail} />;
  const automationsRow = <NavRow
    id="automations"
    label={t("sidebar.nav.automations")}
    tourId="nav-automations"
    iconsOnly={iconsOnly || toolbar}
    active={state.activeView === "routines"}
    attention={automationsNeedYou}
    icon={(active) => <Zap size={iconSize} className={tone(active)} />}
    onClick={() => dispatch({ type: "showRoutines", view: "list" })}
  />;
  const filesRow = useCloudFilesReady() && <NavRow
    id="files"
    label={t("sidebar.nav.files")}
    iconsOnly={iconsOnly}
    rail={rail}
    active={state.activeView === "files"}
    icon={(active) => <FolderOpen size={iconSize} className={tone(active)} />}
    onClick={() => dispatch({ type: "showFiles" })}
  />;
  if (!advanced && !iconsOnly) {
    return hasLocalHostTerminal()
      ? <nav aria-label={t("sidebar.tools")} className="flex flex-col gap-0.5">{terminalRow}</nav>
      : null;
  }
  const appsRow = iconsOnly && <NavRow
    id="apps"
    label={t("sidebar.nav.apps")}
    tourId="nav-apps"
    iconsOnly={iconsOnly}
    rail={rail}
    active={state.pluginsOpen}
    icon={(active) => <Puzzle size={iconSize} className={tone(active)} />}
    onClick={() => dispatch({ type: "togglePlugins", open: true })}
  />;
  if (rail) return <nav data-tour="tools" aria-label={t("sidebar.tools")} className="flex flex-col items-center gap-0.5">{appsRow}{terminalRow}</nav>;

  const rows = (
    <>
      {automationsRow}
      {appsRow}
      {(advanced || iconsOnly) && (
        <NavRow
          id="team-map"
          label={t("sidebar.nav.teamMap")}
          tourId="team-tools"
          iconsOnly={iconsOnly || toolbar}
          active={state.activeView === "team-map"}
          icon={(active) => <UsersRound size={iconSize} className={tone(active)} />}
          onClick={() => dispatch({ type: "showTeamMap" })}
        />
      )}
      {terminalRow}
      {filesRow}
      {advanced && webPanels.map((panel) => (
        <NavRow
          key={panel.id}
          id={`web-panel-${panel.id}`}
          label={panel.name}
          iconsOnly={iconsOnly || toolbar}
          active={state.activeView === "web-panel" && state.webPanelId === panel.id}
          icon={(active) => <Globe size={iconSize} className={tone(active)} />}
          onClick={() => dispatch({ type: "showWebPanel", id: panel.id })}
        />
      ))}
    </>
  );

  if (iconsOnly) {
    return <nav data-tour="tools" aria-label={t("sidebar.tools")} className="flex flex-col items-center gap-1">{rows}</nav>;
  }
  return (
    <div data-tour="tools">
      <SidebarSectionHeader
        name={t("sidebar.tools")}
        collapsed={collapsed}
        alert={collapsed && automationsNeedYou}
        onToggle={onToggleCollapsed}
        reorderable={false}
        dragging={false}
      />
      {!collapsed && <nav aria-label={t("sidebar.tools")} className={toolbar ? "flex flex-row gap-1" : "flex flex-col gap-0.5"}>{rows}</nav>}
    </div>
  );
}
