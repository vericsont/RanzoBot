import { useEffect, useState } from "react";
import { Rocket, Star } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { api, useStore } from "@/state/store";
import { APP_REPOSITORY } from "@/lib/app-links";
import { track } from "@/lib/analytics";
import { brandStatus } from "@/lib/brand";
import { cloudNoticeKind, cloudPlanView, cloudTrialNotice, cloudTrialView } from "@/lib/cloud-plan";
import { jobRoutine, useCloudIntent } from "@/lib/cloud-intent";
import { CLOUD_INTENT_GIVEN, cloudSetupStage } from "@/lib/cloud-setup";
import { cornerPopupWaits, firstChatQuiet, firstReplyPending } from "@/lib/corner-popup";
import { BOAT_OFFER_NOTICE, CLOUD_INTRO, CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, GROK_MOVE_NOTICE, launchNotice, markLaunchNotice, nextNotice, noticeSeen, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, SIMPLE_MODE_NOTICE, STAR_NOTICE, TWO_PLACES_NOTICE, UPDATES_CONSENT_NOTICE, usedBefore, WHATS_NEW_NOTICE } from "@/lib/notices";
import { useTwoPlaces } from "@/lib/two-places";
import { useSimpleModePromptSeen } from "@/lib/simple-mode-prompt";
import { cloudSignInDue, welcomeFinishedThisLaunch, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { useUpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";
import { engineReady } from "./EngineLibrary";
import { CLOUD_NOTICE_CARD, cloudNoticeStep, CloudNoticeCard } from "./CloudNotice";
import { useMoveQuiet } from "./CloudSendStrip";
import { CloudTrialNoticeCard, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { GrokMovePopup, reportGrokMovePopup, type GrokMovePopupAction } from "./GrokMovePopup";
import { GrokMoveDialog } from "./lazy-screens";
import { LinkButton, NoticeCard, NotNowButton } from "./NoticeCard";
import { useDesktopNotices, useOtherDialogOpen } from "./notice-dialogs";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { UpdatesConsentDialog, updatesConsentBridge, useUpdatesConsent } from "./UpdatesConsent";
import { useRanzoBotWelcomeDue } from "./RanzoBotWelcome";
import { reportSimpleModePrompt, SimpleModePrompt } from "./SimpleModePrompt";
import { TwoPlacesCard } from "./TwoPlacesCard";

function StarCard({ onDismiss }: { onDismiss: () => void }) {
  return <NoticeCard titleId="github-star-title" notice="github-star" icon={Star} title={t("star.title")} onDismiss={onDismiss}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("star.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={APP_REPOSITORY} label={t("star.button")} onOpened={onDismiss} />
      <NotNowButton onClick={onDismiss} />
    </div>
  </NoticeCard>;
}

function ProductHuntCard({ onDone }: { onDone: (action: "upvote" | "not_now" | "close") => void }) {
  return <NoticeCard titleId="product-hunt-title" notice="product-hunt" icon={Rocket} title={t("productHunt.title")} onDismiss={() => onDone("close")}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("productHunt.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={PRODUCT_HUNT_URL} label={t("productHunt.button")} onOpened={() => onDone("upvote")} />
      <NotNowButton onClick={() => onDone("not_now")} />
    </div>
  </NoticeCard>;
}

/** A first run lands in its Chief's chat, whose first messages arrive one at a time; the Grok Bot popup follows them. */
const FIRST_MESSAGES_MS = 6_000;

export function AppNotices({ quiet = false, viewer = null, now = Date.now }: { quiet?: boolean; viewer?: WelcomeViewer | null; now?: () => number }) {
  const { state, dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  const local = localDesktopPage();
  const bridge = !remote && local ? window.ogb?.cloudAccount : undefined;
  const desktop = remote ? undefined : window.ogb?.desktopNotices;
  const desktopState = useDesktopNotices(desktop);
  const planBridge = !remote && (bridge || (viewer?.cloudHome && (desktopState || !desktop))) ? window.ogb?.cloudPlan : undefined;
  const plan = useCloudPlanSnapshot(planBridge);
  const [trialOpen, setTrialOpen] = useState<string | null>(null);
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [organization, setOrganization] = useState<boolean | null>(window.ogb?.organization ? null : false);
  const [closed, setClosed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [simpleShown, setSimpleShown] = useState(false);
  const [grokShown, setGrokShown] = useState(false);
  const [grokOpen, setGrokOpen] = useState(false);
  const [grokLanded, setGrokLanded] = useState(false);
  const consentHere = (local || viewer?.cloudHome === true) && brandStatus().source !== "file";
  const consent = useUpdatesConsent(consentHere ? updatesConsentBridge() : undefined);
  const [consentDone, setConsentDone] = useState(false);
  const updater = useUpdaterState();
  const intent = useCloudIntent();
  const moving = useMoveQuiet(now);
  const mausBot = useRanzoBotWelcomeDue(viewer);
  // Bots in two places: this computer's page only, where main knows what lives here.
  const two = useTwoPlaces();
  const twoFact = !local || two.suggest === null ? false : two.suggest === undefined ? null : true;
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    const org = window.ogb?.organization;
    if (!org) return;
    let active = true;
    const read = (next: { status: string; organization?: unknown }) => { if (active) setOrganization(next.status !== "signed-out" && Boolean(next.organization)); };
    const unsubscribe = org.onState(read);
    void org.state().then(read, () => { if (active) setOrganization(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const view = bridge ? cloudPlanView(account) : null;
  const record = state.config?.onboarding;
  const consentDue = consent.state?.available === true && consent.state.due && !consentDone;
  const consentBlocked = useOtherDialogOpen(consentDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const consentFact = !consentHere || consentDone ? false : consent.state === undefined ? null : consentDue ? (consentBlocked ? null : true) : false;
  // Every page with the app's chrome, desktop or Cloud, new install or not: once per browser, as the mode is.
  const simpleDue = !useSimpleModePromptSeen();
  const simpleBlocked = useOtherDialogOpen(simpleDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");

  const trial = plan?.trial;
  const trialKey = trial ? `${trial.state}:${trial.endsAt}` : null;
  const trialDue = cloudTrialNotice(plan);
  const setupRecord = record && (intent.pending || intent.sent) ? { ...record, hintsSeen: [...record.hintsSeen, CLOUD_INTENT_GIVEN] } : record;
  const setupHere = cloudSignInDue(viewer, state, engineReady)
    || ["waiting", "shown"].includes(cloudSetupStage({ viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
      engineReady: state.instances.some(engineReady), onboarding: setupRecord, planned: Boolean(jobRoutine(state.routines, intent.sent)) }));
  const waits = cornerPopupWaits(state, updater, { quiet, idle: true, viewer, duringFirstChat: true }) || setupHere;
  const kind = view ? cloudNoticeKind(view, account) : null;
  const cards = Boolean(bridge || planBridge);
  const firstChat = firstReplyPending(state);
  // RanzoBot's first-launch card goes first: the popup and the question wait while it is due. The popup skips a launch the
  // card used; the question may follow the card once it closes, as it follows the popup.
  const afterWelcome = welcomeFinishedThisLaunch() || launchDialogShown() === "mausbot" || firstChat;
  const consentWaits = welcomeFinishedThisLaunch() || firstChat;
  const mausBotFirst = mausBot.due;
  const consentNow = consentWaits === true || consentFact === false ? false : consentWaits === null || mausBotFirst ? null : consentFact;
  // The Grok Bot popup: once for everyone who can add a bot, the one thing a first chat may be interrupted by. Nothing reads
  // this computer for it: GrokMoveDialog does that, once opened.
  const grokDue = !remote && viewer?.canSave !== false && !state.config?.team && brandStatus().source !== "file" && organization !== true && moving !== true
    && launchDialogShown() !== "mausbot" && !noticeSeen(record, GROK_MOVE_NOTICE) && !desktopState?.seen.includes(GROK_MOVE_NOTICE);
  const grokBlocked = useOtherDialogOpen(grokDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const grokLanding = welcomeFinishedThisLaunch() && !grokLanded;
  useEffect(() => {
    if (!grokDue || !grokLanding || waits) return;
    const timer = setTimeout(() => setGrokLanded(true), FIRST_MESSAGES_MS);
    return () => clearTimeout(timer);
  }, [grokDue, grokLanding, waits]);
  const grokNow = !grokDue ? false
    : !viewer || (desktop && !desktopState) || organization === null || firstChat === null || mausBotFirst || moving === null || grokLanding || grokBlocked ? null : true;
  const launch = launchNotice();
  // After a closed popup only the product-updates question may follow in this launch; nothing else does.
  const notice = waits ? null : closed ? (consentNow === true ? UPDATES_CONSENT_NOTICE : null)
    : firstChatQuiet(state) ? (grokNow === true && (launch === null || launch === GROK_MOVE_NOTICE) ? GROK_MOVE_NOTICE : null)
    : cards || consentHere || simpleDue || twoFact !== false || grokNow !== false ? nextNotice({
    [GROK_MOVE_NOTICE]: grokNow,
    [WHATS_NEW_NOTICE]: false,
    [CLOUD_INTRO]: false,
    [CLOUD_TRIAL_NOTICE]: planBridge && plan === null ? null : Boolean(trialKey && (trialDue || trialOpen === trialKey)),
    [BOAT_OFFER_NOTICE]: false,
    [SIMPLE_MODE_NOTICE]: !simpleDue || afterWelcome === true ? false : afterWelcome === null || mausBotFirst || simpleBlocked ? null : true,
    [UPDATES_CONSENT_NOTICE]: consentNow,
    [TWO_PLACES_NOTICE]: twoFact,
    [PRODUCT_HUNT_NOTICE]: !cards || moving || firstChat === true || brandStatus().source === "file" || now() >= PRODUCT_HUNT_UNTIL ? false
      : organization === null || moving === null || firstChat === null ? null : !organization,
    [CLOUD_NOTICE]: !view ? false : view.kind === "unknown" ? null
      : Boolean(kind && !noticeSeen(record, CLOUD_NOTICE_CARD[kind].dismissed)),
    [STAR_NOTICE]: !bridge || moving || brandStatus().source === "file" || !usedBefore(state.bots) ? false : moving === null ? null : true,
  }, id => id === STAR_NOTICE || id === PRODUCT_HUNT_NOTICE ? noticeSeen(record, id) : false, launch) : null;

  const shownKey = notice === CLOUD_TRIAL_NOTICE ? trialKey : notice;
  useEffect(() => {
    if (!shownKey || !notice) return;
    markLaunchNotice(notice);
    // The popups and the question own this launch: RanzoBot's first-launch card waits for a later one.
    if (shownKey === GROK_MOVE_NOTICE || shownKey === SIMPLE_MODE_NOTICE || shownKey === UPDATES_CONSENT_NOTICE) markLaunchDialog("notices");
    if (notice === CLOUD_TRIAL_NOTICE && trialOpen !== shownKey) {
      setTrialOpen(shownKey);
      void planBridge?.noticeSeen?.().catch(() => {});
    } else if (shownKey === SIMPLE_MODE_NOTICE && !simpleShown) {
      setSimpleShown(true);
      reportSimpleModePrompt("shown");
    } else if (shownKey === GROK_MOVE_NOTICE && !grokShown) {
      setGrokShown(true);
      reportGrokMovePopup("shown");
    }
  }, [shownKey]);

  const save = (id: string) => {
    const patch = dismissNotice(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const close = () => { setClosed(true); setTrialOpen(null); setFailed(false); };
  if (grokOpen) return <GrokMoveDialog onClose={() => setGrokOpen(false)} />;
  if (!notice) return null;

  if (notice === GROK_MOVE_NOTICE) {
    const done = (action: GrokMovePopupAction) => {
      reportGrokMovePopup(action); close(); save(GROK_MOVE_NOTICE);
      void desktop?.seen(GROK_MOVE_NOTICE).catch(() => {});
      if (action === "start") setGrokOpen(true);
    };
    return <GrokMovePopup onDone={done} />;
  }

  if (notice === SIMPLE_MODE_NOTICE) return <SimpleModePrompt onClose={close} />;

  if (notice === UPDATES_CONSENT_NOTICE && consent.state) {
    const done = () => { setConsentDone(true); close(); };
    return <UpdatesConsentDialog signedIn={consent.state.signedIn}
      onYes={async email => { await consent.choose("opted_in", email); done(); }}
      onNo={() => { done(); void consent.choose("declined").catch(() => {}); }} />;
  }
  if (notice === CLOUD_TRIAL_NOTICE && trial) {
    const shown = cloudTrialView({ ...trial, amount: null });
    shown.credit = undefined;
    shown.switchPlan = undefined;
    if (shown.action?.kind === "subscribe") shown.action = null;
    const act = () => { setFailed(false); void planBridge?.manage().then(close, () => setFailed(true)); };
    return <CloudTrialNoticeCard view={shown} failed={failed} onAction={act} onClose={close} />;
  }
  if (notice === CLOUD_NOTICE && kind && bridge) {
    const act = () => {
      if (busy) return;
      setFailed(false); setBusy(true);
      void cloudNoticeStep(kind, bridge).then(next => setAccount(next), () => setFailed(true)).finally(() => setBusy(false));
    };
    return <CloudNoticeCard kind={kind} busy={busy} failed={failed} onAction={act} onNotNow={() => { close(); save(CLOUD_NOTICE_CARD[kind].dismissed); }} />;
  }
  if (notice === TWO_PLACES_NOTICE && two.suggest) {
    const { key, kind } = two.suggest;
    return <TwoPlacesCard key={key} suggest={two.suggest}
      onBring={() => { track("two_places_card", { action: "bring", kind }); return two.accept(key).then(close); }}
      onDismiss={() => { track("two_places_card", { action: "not_now", kind }); two.dismiss(key); close(); }} />;
  }
  if (notice === PRODUCT_HUNT_NOTICE) {
    return <ProductHuntCard onDone={action => { track("product_hunt_card", { action }); close(); save(PRODUCT_HUNT_NOTICE); }} />;
  }
  if (notice === STAR_NOTICE) return <StarCard onDismiss={() => { close(); save(STAR_NOTICE); }} />;
  return null;
}
