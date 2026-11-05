import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer, CloudTrial } from "../../electron/cloud-home.mjs";
import { withTourFinished } from "@/lib/guided-tour";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, LOCAL_VIEWER, markWelcomeFinished, MET_CHIEF_HINT, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { createDesktopPrefs, registerDesktopPrefs } from "../../electron/desktop-prefs.mjs";
import { createUpdatesConsent, registerUpdatesConsent } from "../../electron/updates-consent.mjs";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, updater: null as any, dispatch: null as any, brand: "default",
  viewerEmail: undefined as string | null | undefined }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}),
  CLOUD_LINK_SETTINGS: { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false, track: vi.fn() }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
vi.mock("./cloud-buy/NightCard", () => ({ NightCard: ({ children }: { children: unknown }) => children }));
vi.mock("./whats-new/TeamPicture", () => ({ TeamPicture: () => null }));
// Who RanzoBot belongs to: unknown (as before the session answers) unless a test says otherwise.
vi.mock("@/lib/default-bot", async original => ({ ...await original<typeof import("@/lib/default-bot")>(), useViewerEmail: () => f.viewerEmail }));
vi.mock("@/lib/brand", () => ({ brandStatus: () => ({ brand: { name: "RanzoBot" }, source: f.brand, file: "" }), productName: () => "RanzoBot" }));
vi.mock("./Avatar", async original => ({ ...await original<typeof import("./Avatar")>(), MausAvatar: () => null }));
vi.mock("./lazy-screens", async original => ({ ...await original<typeof import("./lazy-screens")>(), GrokMoveDialog: () => "THE MOVE DIALOG" }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { snapshot: { state: string; authenticated?: boolean } }) =>
  instance.snapshot.state === "available" && instance.snapshot.authenticated !== false }));
import { AppNotices } from "./AppNotices";
import { TwoPlacesCard } from "./TwoPlacesCard";
import { BOAT_OFFER_NOTICE, CLOUD_INTRO, GROK_MOVE_NOTICE, launchNotice, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, STAR_NOTICE, WHATS_NEW_NOTICE } from "@/lib/notices";
import { track } from "@/lib/analytics";
import { ADVANCED_MODE_KEY, setAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_MODE_PROMPT_KEY } from "@/lib/simple-mode-prompt";
import { api } from "@/state/store";

const DAY = 86_400_000, NOW = new Date(2026, 9, 9, 12).getTime();
const plans = [
  { tier: "starter", label: "Starter", amount: 1500, trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 7 },
];
const TRIAL_OFFER: CloudOffer = { plans, recommended: "pro", creditUsd: 5, refundDays: 14 };
const PLAIN_OFFER: CloudOffer = { plans: plans.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro", refundDays: 14 };
const STAR = "Enjoying RanzoBot?";
const signedOut: CloudAccountState = { status: "signed-out" };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const ready = { status: "ready" as const, origin: "https://omb-u-1.fly.dev" };
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });

let storage: Map<string, string>;
let account: CloudAccountState;
let snapshot: CloudPlanSnapshot | Error;
let offer: CloudOffer | null;
let viewer: WelcomeViewer | null;
let bridges: { cloud: Record<string, ReturnType<typeof vi.fn>>; plan: Record<string, ReturnType<typeof vi.fn>> };
let accountListeners: Set<(next: CloudAccountState) => void>;
let now: number;

const PRELOAD = readFileSync(join(process.cwd(), "electron", "preload.cjs"), "utf8").replace(/\r\n/g, "\n");
const LOCAL_ORIGIN = "http://127.0.0.1:8799", MY_CLOUD = "https://omb-u-1.fly.dev", VPS = "https://bots.example.test";
type Page = "local" | "cloud" | "server";
type Handler = (event: { page: Page; returnValue?: unknown }, ...args: unknown[]) => unknown;
interface Desktop {
  handlers: Map<string, Handler>; listeners: Map<string, Handler>; saved: { seen?: string[] } | null; offered: boolean;
  /** This computer's own workspace config.json, as main reads it. */
  config: unknown;
}
let desk: Desktop;

// Main's own record for this one desktop, behind its real IPC.
function desktopMachine(): Desktop {
  const machine: Desktop = { handlers: new Map(), listeners: new Map(), saved: null, offered: true,
    config: { onboarding: { completedAt: "2026-09-01", version: 1, hintsSeen: [] } } };
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => void machine.handlers.set(channel, handler as Handler), on: (channel, listener) => void machine.listeners.set(channel, listener as Handler) },
    read: () => machine.saved, write: value => { machine.saved = JSON.parse(JSON.stringify(value)); }, page: event => (event as { page: Page }).page,
    cloudOffered: async () => machine.offered, localConfig: () => machine.config, now: () => now,
  });
  return machine;
}

// The real preload, as this desktop's window loads it for a page; the Cloud account and plan answer from this file's fakes.
function windowOn(origin: string, { click = true } = {}) {
  const page: Page = origin === LOCAL_ORIGIN ? "local" : origin === MY_CLOUD ? "cloud" : "server";
  let ogb: Record<string, unknown> = {};
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL_ORIGIN}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: click } }, TextEncoder,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name: string, value: Record<string, unknown>) => { ogb = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {},
        sendSync: (channel: string) => { const event = { page, returnValue: undefined as unknown }; desk.listeners.get(channel)?.(event); return event.returnValue; },
        invoke: async (channel: string, ...args: unknown[]) => desk.handlers.get(channel)?.({ page }, ...args) } }),
  });
  const fakes: Record<string, unknown> = { cloudAccount: bridges.cloud, cloudPlan: bridges.plan, openExternal: vi.fn(async () => true), organization: undefined };
  return { ...ogb, ...Object.fromEntries(Object.entries(fakes).filter(([key]) => key in ogb)) };
}
const showWindow = (origin: string, options?: { click?: boolean }) => {
  vi.stubGlobal("window", { ogb: windowOn(origin, options), addEventListener: vi.fn(), removeEventListener: vi.fn() });
};

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(AppNotices, { viewer, now: () => now })); };
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) { render(); f.effects.forEach(effect => effect()); await flush(); } return render(); }
const launch = () => { f.values = []; return settle(); };
/** The app opened again: a new window session, so nothing this launch showed holds the next one back. */
const relaunch = () => { session.clear(); return launch(); };
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const tree = () => { f.index = 0; f.effects = []; return nodes(AppNotices({ viewer, now: () => now })); };
const press = (label: string) => {
  const button = tree().find(node => node.type === "button" && (renderToStaticMarkup(node).includes(`>${label}<`) || node.props["aria-label"] === label));
  expect(button, label).toBeTruthy(); button!.props.onClick();
};
/** A bot has answered once, in this launch: what a new install has after its first chat. */
const FIRST_REPLY = [{ tasks: [{ threadId: "first", usage: { turns: 1 } }] }];
let session: Map<string, string>;
const returning = () => { f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; };
const launchCardsSeen = () => { desk.saved = { seen: [WHATS_NEW_NOTICE] }; storage.set(GROK_MOVE_NOTICE, "1"); storage.set(PRODUCT_HUNT_NOTICE, "1"); storage.set(SIMPLE_MODE_PROMPT_KEY, "1"); storage.set(BOAT_OFFER_NOTICE, "1"); };
const hints = () => f.state.config.onboarding.hintsSeen as string[];

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  storage = new Map(); f.values = []; f.index = 0; f.effects = []; f.updater = null; f.brand = "default"; f.dispatch = vi.fn(); now = NOW; desk = desktopMachine();
  setLocale("en"); viewer = LOCAL_VIEWER; account = signedOut; snapshot = { status: "none" }; offer = TRIAL_OFFER;
  session = new Map(); f.viewerEmail = undefined;
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
  f.state = { connected: true, hydrated: true, bots: structuredClone(FIRST_REPLY), groups: [], routines: [], instances: [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }],
    config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: withTourFinished(undefined) } } };
  vi.mocked(api).mockImplementation(async (_path, init) => {
    const patch = JSON.parse(String((init as RequestInit).body));
    f.state.config.onboarding.hintsSeen = patch.onboarding.hintsSeen;
    return f.state.config;
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  // The popups, the Product Hunt card and Boat's offer start seen: the tests before their own are about the other cards.
  launchCardsSeen();
  accountListeners = new Set();
  bridges = {
    cloud: { state: vi.fn(async () => account), onState: vi.fn((listener: (next: CloudAccountState) => void) => { accountListeners.add(listener); return () => accountListeners.delete(listener); }),
      offer: vi.fn(async () => offer), begin: vi.fn(async () => account),
      signInAgain: vi.fn(async () => account), connectHome: vi.fn(async () => account), openDashboard: vi.fn(async () => account) },
    plan: { state: vi.fn(async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; }), manage: vi.fn(async () => {}), noticeSeen: vi.fn(async () => {}) },
  };
  showWindow(LOCAL_ORIGIN);
  vi.stubGlobal("document", { activeElement: null, body: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

it("does not show Cloud purchase promotions or request offers", async () => {
  returning();
  desk.saved = null;
  storage.delete(WHATS_NEW_NOTICE);
  storage.delete(BOAT_OFFER_NOTICE);
  const html = await launch();
  expect(html).not.toContain("Start free trial");
  expect(html).not.toContain("Meet the new RanzoBot Cloud");
  expect(html).not.toContain("Get Boat");
  expect(bridges.cloud.offer).not.toHaveBeenCalled();
});

describe("the free trial's notice, here and on My Cloud", () => {
  it("shows the notice main says is due, tells main once, and stays up until it is closed", async () => {
    const running = trial("active", { switchTo: { tier: "starter", amount: 1500 } });
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active", credit: { grantedUsd: 5, remainingUsd: 3.2, state: "active" } };
    offer = { ...PLAIN_OFFER };
    const html = await launch();
    expect(html).toContain("Your free trial ends on");
    expect(html).not.toContain("$15");
    expect(html).not.toContain("$49");
    expect(bridges.cloud.offer, "the trial's notice needs nothing from the offer").not.toHaveBeenCalled();
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    snapshot = { ...snapshot, notice: undefined };
    expect(await settle()).toContain("Your free trial ends on");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    press("Manage subscription"); await flush();
    expect(bridges.plan.manage).toHaveBeenCalledOnce();
    expect(render()).toBe("");
    expect(await launch()).not.toContain("Your free trial");
  });

  it("on My Cloud's own page, only the trial's notice, after its sign-in and setup checklist", async () => {
    viewer = { hosted: false, canSave: true, cloudHome: true };
    showWindow(MY_CLOUD);
    returning();
    snapshot = { status: "none", trial: trial("ended", { deleteAt: NOW + 3 * DAY, keep: "checkout" }), notice: "ended" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"];
    expect(await launch()).toContain("Your free trial has ended");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: false } }];
    expect(await launch()).toBe("");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }];
    snapshot = { status: "none" };
    expect(await launch()).toBe("");
    expect(bridges.cloud.offer).not.toHaveBeenCalled();
    snapshot = new Error("only available in this app's window");
    expect(await launch()).toBe("");
  });
});

describe("the first conversation after meeting the Chief", () => {
  it("holds every corner notice, an account's own too, until the person has written and had a reply", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), MET_CHIEF_HINT];
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    expect(await launch()).toBe("");
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(await launch()).toContain("Your free trial ends on");
  });

  it("changes nothing for an install whose first run came before: its notices keep their own rules", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    expect(await launch()).toContain("Your free trial ends on");
  });
});

describe("This computer's Cloud sign-in card and the star", () => {
  it("an ended sign-in on a paid plan asks to sign in again; the star comes last and is for good", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }; returning();
    expect(await launch()).toContain("Sign in again to reach the Cloud");
    press("Sign in again"); await flush();
    expect(bridges.cloud.signInAgain).toHaveBeenCalledOnce();
    account = { ...free }; offer = { ...PLAIN_OFFER };
    expect(await relaunch()).toContain(STAR);
    press("Not now");
    expect(storage.get(STAR_NOTICE)).toBe("1"); expect(await relaunch()).toBe("");
  });
});

describe("the Product Hunt launch card", () => {
  const PH = "live on Product Hunt";
  const fresh = () => { storage.delete(PRODUCT_HUNT_NOTICE); };

  it("waits for a new install's first reply, so it never lands on the first chat", async () => {
    fresh(); f.state.bots = [];
    expect(await launch()).not.toContain(PH);
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(await launch()).toContain(PH);
  });

  it("comes first, for everyone (new or not, any plan), and the upvote opens the launch and ends it for good", async () => {
    fresh(); account = paid({ machine: ready });
    const html = await launch();
    expect(html).toContain(PH); expect(html).toContain("Upvote on Product Hunt");
    expect(html).not.toContain(STAR); expect(html).not.toContain("Your always-on bots are in the Cloud");
    press("Upvote on Product Hunt"); await flush();
    expect(window.ogb?.openExternal).toHaveBeenCalledWith(PRODUCT_HUNT_URL);
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "upvote" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1"); expect(hints()).toContain(PRODUCT_HUNT_NOTICE);
    expect(await launch()).not.toContain(PH);
  });

  it("Not now, the X and Escape end it for good too", async () => {
    fresh();
    expect(await launch()).toContain(PH);
    press("Not now");
    expect(vi.mocked(track)).toHaveBeenCalledWith("product_hunt_card", { action: "not_now" });
    expect(storage.get(PRODUCT_HUNT_NOTICE)).toBe("1");
    expect(await launch()).not.toContain(PH);
  });

  it("never while the bots move to My Cloud, nor in the first minutes after; the star and the Cloud offers wait too", async () => {
    fresh(); returning(); storage.delete(STAR_NOTICE);
    const line = (move: unknown) => desk.handlers.set("cloud-send:notice", () => ({ ready: true, bots: [], move }));
    for (const move of [{ phase: "copy", chats: { done: 1, total: 5 } }, { phase: "wait" }, { phase: "finishing" }, { phase: "copy", failing: { error: null } }, { phase: "home-again" }]) {
      line(move);
      const html = await launch();
      expect(html, JSON.stringify(move)).not.toContain(PH); expect(html, JSON.stringify(move)).not.toContain(STAR);
    }
    line({ phase: "done", at: NOW - 60_000, phone: false, held: [] });
    expect(await launch(), "a minute after: still quiet").not.toContain(PH);
    line(undefined);
    expect(await settle(), "the done line closed a minute after: still quiet").not.toContain(PH);
    line({ phase: "done", at: NOW - 6 * 60_000, phone: false, held: [] });
    expect(await launch(), "some minutes after: the card shows").toContain(PH);
    line(undefined);
    expect(await launch(), "no move at all").toContain(PH);
    desk.handlers.set("cloud-send:notice", () => { throw new Error("cloud-send:notice is only available in this app's window"); });
    expect(await launch(), "a page main tells nothing").toContain(PH);
    desk.handlers.set("cloud-send:notice", () => new Promise(() => {}));
    expect(await launch(), "until main says whether a move goes, nothing shows").not.toContain(PH);
  });

  it("never on a branded build or an organization's desktop, never after the launch window, never over setup or an update", async () => {
    fresh(); f.brand = "file";
    expect(await launch()).not.toContain(PH);
    f.brand = "default"; now = PRODUCT_HUNT_UNTIL;
    expect(await launch()).not.toContain(PH);
    now = NOW; f.updater = { status: "available", version: "9.9.9" };
    expect(await launch()).not.toContain(PH);
  });
});

describe("the product-updates question after the update", () => {
  const QUESTION = "Get RanzoBot updates?", POPUP = "Meet the new RanzoBot Cloud";
  const RECEIPT = "R".repeat(43);
  let saved: unknown;
  let accountAnswer: { status: string; textVersion: string } | null;
  let client: Record<string, ReturnType<typeof vi.fn>>;
  /** Main's own consent for this desktop, behind its real IPC: the real record and logic, a fake Cloud client. */
  const wireConsent = () => {
    const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = JSON.parse(JSON.stringify(value)); } });
    const consent = createUpdatesConsent({ prefs, account: () => client as never, available: async () => true, now: () => now });
    registerUpdatesConsent({ ipcMain: { handle: (channel, handler) => void desk.handlers.set(channel, handler as Handler) }, page: event => (event as { page: Page }).page, consent });
  };
  const answer = () => (saved as { updatesConsent?: { status: string } } | null)?.updatesConsent ?? null;
  const type = (value: string) => { const input = tree().find(node => node.type === "input" && node.props.type === "email")!; expect(input).toBeTruthy(); input.props.onChange({ target: { value } }); };

  beforeEach(() => {
    saved = null; accountAnswer = null;
    client = { state: vi.fn(() => account), updatesConsent: vi.fn(async () => ({ cloudContractVersion: 1, consent: accountAnswer })),
      recordUpdatesConsent: vi.fn(async (status: string, textVersion: string) => { accountAnswer = { status, textVersion }; }),
      updatesConsentByEmail: vi.fn(async () => RECEIPT), withdrawUpdatesConsent: vi.fn(async () => {}) };
    wireConsent();
  });

  it("appears without a Cloud promotion; No thanks is kept and it is never asked again", async () => {
    desk.saved = null; storage.delete(WHATS_NEW_NOTICE);
    const first = await launch();
    expect(first).not.toContain(POPUP); expect(first).toContain(QUESTION);
    const next = await launch();
    expect(next, "and after a reload in the same launch").toContain(QUESTION); expect(next).not.toContain(POPUP);
    for (const text of ["about new features and tips, about twice a month. You can unsubscribe any time.", "Your email", "Yes, send me updates", "No thanks"])
      expect(next).toContain(text);
    for (const part of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="updates-consent-title"', 'type="email"', 'value=""']) expect(next).toContain(part);
    expect(next).not.toContain('type="checkbox"');
    press("No thanks"); await flush();
    expect(render()).toBe("");
    expect(answer()).toMatchObject({ status: "declined" });
    expect(client.updatesConsentByEmail).not.toHaveBeenCalled();
    expect(await launch()).not.toContain(QUESTION);
    wireConsent();
    expect(await launch(), "a restart reads it from the desktop's file").not.toContain(QUESTION);
  });

  it("waits for a new install's first reply and a later launch", async () => {
    desk.saved = null; storage.delete(WHATS_NEW_NOTICE);
    f.state.bots = [];
    markWelcomeFinished();
    const first = await launch();
    expect(first, "the welcome just closed and no bot has answered").not.toContain(QUESTION); expect(first).not.toContain(POPUP);
    f.state.bots = structuredClone(FIRST_REPLY);
    const answered = await launch();
    expect(answered, "a bot has answered, but in the launch the welcome finished").not.toContain(QUESTION); expect(answered).not.toContain(POPUP);
    session.clear();
    const later = await launch();
    expect(later).not.toContain(POPUP); expect(later).toContain(QUESTION);
  });

  it("waits while RanzoBot's first-launch card is due, then follows it in the same launch once it closes", async () => {
    f.viewerEmail = null;
    f.state.bots = [{ ...structuredClone(FIRST_REPLY[0]), id: "maus", defaultBot: {} }];
    expect(await launch(), "the card is due: the question waits for it").not.toContain(QUESTION);
    markLaunchDialog("mausbot"); f.state.bots[0].welcomed = true;
    const after = await launch();
    expect(after, "the card closed in this launch: the question follows it, as it follows the popup").toContain(QUESTION);
    expect(after, "the popup still waits for a later launch").not.toContain(POPUP);
  });

  it("never during onboarding, the tour or Settings; it shows once they are done, before the other cards", async () => {
    returning();
    f.state.welcomeOpen = true; expect(await launch()).toBe("");
    f.state.welcomeOpen = false; f.state.appSettingsOpen = true; expect(await launch()).toBe("");
    f.state.appSettingsOpen = false;
    const html = await launch();
    expect(html).toContain(QUESTION); expect(html).not.toContain(STAR);
  });

  it("signed out: an optional email; Yes sends it with no account and keeps the receipt. Signed in: one tap, on the account", async () => {
    await launch(); expect(await settle()).toContain(QUESTION);
    type("not-an-email"); press("Yes, send me updates"); await flush();
    expect(render()).toContain("Enter a valid email address.");
    expect(client.updatesConsentByEmail).not.toHaveBeenCalled();
    type("person@example.test"); press("Yes, send me updates");
    for (let i = 0; i < 5; i++) await flush();
    expect(client.updatesConsentByEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "person@example.test", textVersion: "2026-10-23" }));
    expect(answer()).toMatchObject({ status: "opted_in", email: "person@example.test", receipt: RECEIPT });
    expect(render()).toBe("");

    saved = null; account = free; wireConsent();
    await launch(); const signedIn = await settle();
    expect(signedIn).toContain(QUESTION); expect(signedIn).not.toContain('type="email"');
    press("Yes, send me updates");
    for (let i = 0; i < 5; i++) await flush();
    expect(client.recordUpdatesConsent).toHaveBeenCalledWith("opted_in", "2026-10-23");
    expect(answer()).toMatchObject({ status: "opted_in", account: "a" });
    expect(await launch()).not.toContain(QUESTION);
  });

  it("not on a branded build, a saved server's page, or in a remote client's window; My Cloud's own page asks too", async () => {
    f.brand = "file"; expect(await launch()).not.toContain(QUESTION);
    f.brand = "default";
    viewer = { hosted: true, canSave: true }; showWindow(VPS); expect(await launch()).not.toContain(QUESTION);
    showWindow(LOCAL_ORIGIN); viewer = LOCAL_VIEWER; (window.ogb as Record<string, any>).remoteClient.active = true;
    expect(await launch()).not.toContain(QUESTION);
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    expect(await launch()).toContain(QUESTION);
    expect(answer()).toBeNull();
  });
});

describe("no Use my Mac popup", () => {
  it("the page never asks main for one, whatever an older main would answer, and the cards go on as before", async () => {
    const asked: unknown[] = [];
    desk.handlers.set("cloud-lending:due", async () => true);
    desk.handlers.set("cloud-lending:ask", (_event: unknown, language: unknown) => { asked.push(language); return Promise.resolve(); });
    returning(); storage.set(CLOUD_INTRO, "1");
    expect(await launch()).toContain(STAR);
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    await launch();
    expect(asked, "on this computer's page and on My Cloud's own page").toEqual([]);
  });
});

describe("the Move from Grok Bot popup", () => {
  const TITLE = "Move from Grok Bot", WHATS_NEW = "Meet the new RanzoBot Cloud", DIALOG = "THE MOVE DIALOG";
  let modal: boolean;
  const events = () => vi.mocked(track).mock.calls.filter(([name]) => name === "grok_move_popup").map(([, props]) => (props as { action: string }).action);
  const reads = () => vi.mocked(api).mock.calls.map(([path]) => path).filter(path => path === "/api/setup-import/grok");
  const keydown = (key: string) => {
    const handler = vi.mocked(window.addEventListener).mock.calls.filter(([type]) => type === "keydown").at(-1)![1] as (event: unknown) => void;
    handler({ key, preventDefault() {}, stopPropagation() {} });
  };
  const endedForGood = async () => {
    expect(render()).toBe("");
    expect(storage.get(GROK_MOVE_NOTICE)).toBe("1"); expect(hints()).toContain(GROK_MOVE_NOTICE); expect(desk.saved?.seen).toContain(GROK_MOVE_NOTICE);
    expect(await launch(), "a reload is the same launch").not.toContain(TITLE);
    expect(await relaunch(), "nor any later one").not.toContain(TITLE);
  };

  beforeEach(() => {
    modal = false;
    storage.delete(GROK_MOVE_NOTICE);
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null,
      querySelector: (selector: string) => selector === "[data-grok-move-popup]" ? { querySelectorAll: () => [] } : null,
      querySelectorAll: () => modal ? [{ closest: () => null, checkVisibility: () => true }] : [] });
  });

  it("someone already here sees it at their next launch, a modal with the two marks, and it reads nothing on this computer", async () => {
    returning();
    const html = await launch();
    for (const text of [TITLE, "Bring your Bots here, with their skills, routines and memories.", "Let&#x27;s start", "Not now"]) expect(html).toContain(text);
    for (const part of ['role="dialog"', 'aria-modal="true"', "data-grok-move-popup"]) expect(html).toContain(part);
    expect(events()).toEqual(["shown"]);
    expect(launchNotice()).toBe(GROK_MOVE_NOTICE);
    expect(launchDialogShown(), "RanzoBot's card waits for a later launch").toBe("notices");
    expect(await settle()).toContain(TITLE);
    expect(events(), "shown is counted once").toHaveLength(1);
    expect(reads(), "showing it looks at neither Downloads nor the Grok Bot app").toEqual([]);
  });

  it("goes first in the queue, one a launch: What's new, then the rest, wait for later launches", async () => {
    returning(); desk.saved = null; storage.delete(SIMPLE_MODE_PROMPT_KEY); storage.delete(BOAT_OFFER_NOTICE); storage.delete(STAR_NOTICE);
    const first = await launch();
    expect(first).toContain(TITLE);
    for (const other of ["data-simple-mode-prompt", WHATS_NEW, STAR]) expect(first).not.toContain(other);
    press("Not now"); await flush();
    expect(render(), "nothing else after it in this launch").toBe("");
    expect(await launch(), "a reload is the same launch").toBe("");
    const second = await relaunch();
    expect(second).toContain("data-simple-mode-prompt"); expect(second).not.toContain(TITLE);
    expect(launchNotice()).not.toBe(GROK_MOVE_NOTICE);
  });

  it("never during onboarding; after a new install's welcome it follows the first messages, while the other cards keep to the first chat's quiet", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    storage.delete(STAR_NOTICE);
    f.state.bots = [{ tasks: [{ threadId: "first" }] }];
    f.state.config.onboarding = { ...EMPTY_ONBOARDING };
    expect(await launch(), "the welcome is due").toBe("");
    f.state.welcomeOpen = true;
    f.state.config.onboarding = { ...EMPTY_ONBOARDING, completedAt: "2026-11-01", version: 1, hintsSeen: [MET_CHIEF_HINT] };
    expect(await launch(), "the welcome is open").toBe("");
    f.state.welcomeOpen = false; markWelcomeFinished();
    expect(await settle(), "its first messages are still arriving").toBe("");
    expect(events()).toEqual([]);
    vi.advanceTimersByTime(6_000);
    const html = await settle();
    expect(html).toContain(TITLE); expect(html).not.toContain(STAR);
    press("Let&#x27;s start"); await flush();
    expect(render()).toContain(DIALOG);
    expect(events()).toEqual(["shown", "start"]);
    expect(storage.get(GROK_MOVE_NOTICE)).toBe("1");
  });

  it("Not now, the X and Escape end it for good, on this computer and in the workspace", async () => {
    for (const how of ["Not now", "Close", "Escape"] as const) {
      session.clear(); storage.delete(GROK_MOVE_NOTICE); desk = desktopMachine(); desk.saved = { seen: [WHATS_NEW_NOTICE] }; f.state.config.onboarding.hintsSeen = withTourFinished(undefined);
      returning();
      expect(await launch(), how).toContain(TITLE);
      if (how === "Escape") keydown("Escape"); else press(how);
      await flush();
      await endedForGood();
    }
    expect(events().filter(action => action !== "shown")).toEqual(["not_now", "close", "close"]);
  });

  it("Let's start opens the same dialog, ends the popup for good, and only the dialog looks on this computer", async () => {
    returning();
    await launch();
    press("Let&#x27;s start"); await flush();
    expect(render()).toContain(DIALOG);
    expect(events()).toEqual(["shown", "start"]);
    expect(storage.get(GROK_MOVE_NOTICE)).toBe("1"); expect(hints()).toContain(GROK_MOVE_NOTICE); expect(desk.saved?.seen).toContain(GROK_MOVE_NOTICE);
    expect(reads()).toEqual([]);
    expect(await relaunch()).not.toContain(TITLE);
  });

  it("never during a bot's turn, a dialog, a call or while a move is starting up; it comes when they end", async () => {
    returning();
    f.state.bots = [{ busy: true, tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }];
    expect(await launch(), "a turn").toBe("");
    returning();
    modal = true;
    expect(await launch(), "another dialog").toBe("");
    modal = false;
    f.state.liveCall = { status: "connected" };
    expect(await launch(), "a call").toBe("");
    f.state.liveCall = null;
    expect(await launch()).toContain(TITLE);
  });

  it("seen on this desktop from another page, it doesn't come back", async () => {
    returning(); desk.saved = { seen: [WHATS_NEW_NOTICE, GROK_MOVE_NOTICE] };
    expect(await launch()).not.toContain(TITLE);
  });

  it("a page newer than its desktop: main ignores the new id, and the workspace and this browser still end it for good", async () => {
    returning();
    desk.handlers.set("desktop-notices:seen", async () => undefined);
    desk.handlers.set("desktop-notices:state", async () => ({ seen: [WHATS_NEW_NOTICE], cloud: false }));
    expect(await launch()).toContain(TITLE);
    press("Not now"); await flush();
    expect(storage.get(GROK_MOVE_NOTICE)).toBe("1"); expect(hints()).toContain(GROK_MOVE_NOTICE);
    expect(await relaunch()).not.toContain(TITLE);
    storage.delete(GROK_MOVE_NOTICE);
    expect(await relaunch(), "in another browser, the workspace remembers").not.toContain(TITLE);
  });

  it("stays away from those who can't add a bot and from what isn't ours to promote: a member, a Team Cloud, a branded build", async () => {
    returning();
    viewer = { hosted: true, canSave: false };
    expect(await launch(), "a member").not.toContain(TITLE);
    viewer = LOCAL_VIEWER;
    f.state.config.team = { id: "t", name: "Acme" };
    expect(await relaunch(), "a Team Cloud").not.toContain(TITLE);
    delete f.state.config.team;
    f.brand = "file";
    expect(await relaunch(), "a branded build").not.toContain(TITLE);
  });
});

describe("the Simple mode popup after the update", () => {
  const TITLE = "Try the new Simple mode", ON = "You&#x27;re on Simple mode", POPUP = "Meet the new RanzoBot Cloud";
  let modal: boolean;
  const prompts = () => vi.mocked(track).mock.calls.filter(([event]) => event === "simple_mode_prompt").map(([, props]) => props);

  beforeEach(() => {
    modal = false;
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => modal ? [{ closest: () => null, checkVisibility: () => true }] : [] });
    setAdvancedMode(true);
    storage.delete(SIMPLE_MODE_PROMPT_KEY);
  });

  it("shows once in each browser, claims the launch, and never comes back once it is closed", async () => {
    const html = await launch();
    expect(html).toContain(TITLE);
    for (const part of ['role="dialog"', 'aria-modal="true"', 'role="switch"', 'aria-checked="false"', "Switch any time in Settings → General."]) expect(html).toContain(part);
    expect(prompts()).toEqual([{ action: "shown", mode: "advanced" }]);
    expect(launchDialogShown()).toBe("notices");
    expect(await settle(), "shown is counted once").toContain(TITLE);
    expect(prompts()).toHaveLength(1);
    press("Done"); await flush();
    expect(render(), "nothing else in this launch after it").toBe("");
    expect(storage.get(SIMPLE_MODE_PROMPT_KEY)).toBe("1");
    expect(prompts()).toEqual([{ action: "shown", mode: "advanced" }, { action: "closed", mode: "advanced" }]);
    session.clear();
    expect(await launch()).not.toContain(TITLE);
    expect(prompts()).toHaveLength(2);
  });

  it("changes the mode live from the popup, both ways, while its words stay", async () => {
    await launch();
    press("Simple mode"); await flush();
    expect(storage.get(ADVANCED_MODE_KEY)).toBe("0");
    const on = render();
    expect(on).toContain('aria-checked="true"'); expect(on).toContain(TITLE);
    press("Simple mode"); await flush();
    expect(storage.get(ADVANCED_MODE_KEY)).toBe("1");
    expect(render()).toContain('aria-checked="false"');
    expect(prompts().slice(1)).toEqual([{ action: "toggled", mode: "simple" }, { action: "toggled", mode: "advanced" }]);
    expect(storage.has(SIMPLE_MODE_PROMPT_KEY), "flipping never closes it").toBe(false);
  });

  it("tells someone already on Simple mode so, with the switch on", async () => {
    setAdvancedMode(false);
    const html = await launch();
    expect(html).toContain(ON); expect(html).toContain('aria-checked="true"');
    expect(prompts()).toEqual([{ action: "shown", mode: "simple" }]);
  });

  it("asks on the Cloud's own page and in a plain browser too, not only on this computer's", async () => {
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    expect(await launch()).toContain(TITLE);
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    viewer = { hosted: true, canSave: true }; f.state.config.cloudHome = false;
    expect(await launch()).toContain(TITLE);
  });

  it("waits during the welcome, the tour, Settings, the quiet first chat, another dialog or a call, and skips the launch its welcome finished in", async () => {
    const waits: Array<() => void> = [
      () => { f.state.welcomeOpen = true; }, () => { f.state.tourOpen = true; }, () => { f.state.appSettingsOpen = true; }, () => { modal = true; },
      () => { f.state.liveCall = { status: "live" }; }, () => { f.state.config.onboarding.completedAt = undefined; },
      () => { f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), MET_CHIEF_HINT]; f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }]; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).not.toContain(TITLE);
      f.state = saved; modal = false;
    }
    expect(prompts()).toEqual([]);
    markWelcomeFinished();
    expect(await launch(), "the launch the welcome finished in").not.toContain(TITLE);
    session.clear();
    expect(await launch()).toContain(TITLE);
    expect(storage.has(SIMPLE_MODE_PROMPT_KEY)).toBe(false);
  });

  it("does not show the removed Cloud promotion on a later launch", async () => {
    desk.saved = null; storage.delete(WHATS_NEW_NOTICE);
    const first = await launch();
    expect(first).toContain(TITLE); expect(first).not.toContain(POPUP);
    press("Done"); await flush();
    expect(render()).toBe("");
    session.clear();
    const later = await launch();
    expect(later).not.toContain(POPUP); expect(later).not.toContain(TITLE);
  });
});

describe("bots in two places", () => {
  const GARAGE = { key: "server:https://garage.example.test", name: "Garage server", kind: "server" as const };
  const BODY = "Your bots live in two places, so they can&#x27;t work together. Bring them together on Garage server?";
  let suggest: { key: string; name: string; kind: "cloud" | "server" } | null;
  let accepted: string[], dismissed: string[];
  beforeEach(() => {
    suggest = GARAGE; accepted = []; dismissed = [];
    desk.handlers.set("two-places:state", async () => ({ suggest }));
    desk.handlers.set("two-places:accept", async (_event, key) => { accepted.push(String(key)); suggest = null; return { suggest }; });
    desk.handlers.set("two-places:dismiss", async (_event, key) => { dismissed.push(String(key)); suggest = null; return { suggest }; });
  });

  it("one plain card on this computer's page, before any promotion; bots move there only after the person confirms (#4192)", async () => {
    returning();
    storage.delete(PRODUCT_HUNT_NOTICE);
    const html = await launch();
    expect(html).toContain('data-notice="two-places"');
    expect(html).toContain("Bring your bots together");
    expect(html).toContain(BODY);
    expect(html).not.toContain(STAR);
    press("Bring them together");
    const asking = await settle();
    expect(accepted, "one tap never moves anyone").toEqual([]);
    expect(asking).toContain("Move this computer&#x27;s bots to Garage server?");
    expect(asking, "the undo switch is My Cloud's only").not.toContain("Keep this computer&#x27;s bots on this computer");
    press("Move bots");
    await flush();
    expect(accepted).toEqual([GARAGE.key]);
    expect(track).toHaveBeenCalledWith("two_places_card", { action: "bring", kind: "server" });
    expect(await settle()).not.toContain('data-notice="two-places"');
  });

  it("Cancel on the confirm step moves nothing and keeps the card (#4192)", async () => {
    returning();
    suggest = { key: "cloud:mine", name: "My Cloud", kind: "cloud" };
    await launch();
    press("Bring them together");
    const asking = await settle();
    expect(asking).toContain("Move this computer&#x27;s bots to My Cloud?");
    expect(asking, "My Cloud names the way back").toContain("Keep this computer&#x27;s bots on this computer");
    press("Cancel");
    const after = await settle();
    expect(accepted).toEqual([]);
    expect(dismissed).toEqual([]);
    expect(after).toContain('data-notice="two-places"');
    expect(after).not.toContain("Move bots");
    expect(after).toContain("Bring them together");
    expect(tree().find(node => node.props["data-two-places-bring"])?.props.autoFocus, "focus returns to the button Cancel brought back").toBe(true);
  });

  it("Escape on the confirm step works as Cancel and never dismisses the card", async () => {
    returning();
    await launch();
    press("Bring them together");
    await settle();
    const escape = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    tree().find(node => node.props.role === "group")!.props.onKeyDown(escape);
    expect(escape.stopPropagation, "the card's own Escape never sees it").toHaveBeenCalled();
    const after = await settle();
    expect(dismissed).toEqual([]);
    expect(accepted).toEqual([]);
    expect(after).toContain('data-notice="two-places"');
    expect(after).not.toContain("Move bots");
  });

  it("a different suggested place starts a fresh card, so a confirm never carries over to it", async () => {
    returning();
    await launch();
    // Children.toArray would re-key, so walk the elements as rendered.
    const find = (value: unknown): Node | undefined => {
      if (Array.isArray(value)) return value.map(find).find(Boolean);
      if (!isValidElement(value)) return undefined;
      const node = value as Node;
      if (node.type === TwoPlacesCard) return node;
      return typeof node.type === "function" ? find((node.type as (props: unknown) => ReactNode)(node.props)) : find(node.props.children);
    };
    f.index = 0; f.effects = [];
    expect(find(AppNotices({ viewer, now: () => now }))?.key).toBe(GARAGE.key);
  });

  it("Not now hands main the place to remember, and the card goes", async () => {
    returning();
    expect(await launch()).toContain(BODY);
    press("Not now");
    await flush();
    expect(dismissed).toEqual([GARAGE.key]);
    expect(await settle()).not.toContain('data-notice="two-places"');
    expect(await launch(), "main remembers it: never asked again").not.toContain('data-notice="two-places"');
  });

  it("never during the welcome or the tour, on a Cloud's or a server's page, or when main suggests nothing", async () => {
    returning();
    f.state.welcomeOpen = true;
    expect(await launch()).not.toContain('data-notice="two-places"');
    f.state.welcomeOpen = false; f.state.tourOpen = true;
    expect(await launch()).not.toContain('data-notice="two-places"');
    f.state.tourOpen = false;
    for (const origin of [MY_CLOUD, VPS]) {
      showWindow(origin);
      expect(await launch(), origin).not.toContain('data-notice="two-places"');
    }
    showWindow(LOCAL_ORIGIN);
    suggest = null;
    expect(await launch()).not.toContain('data-notice="two-places"');
  });

  it("is this computer's page's alone: no other page gets the bridge, and none would show it", async () => {
    returning();
    expect(windowOn(LOCAL_ORIGIN).twoPlaces).toBeDefined();
    for (const origin of [MY_CLOUD, VPS]) expect(windowOn(origin).twoPlaces, origin).toBeUndefined();
    const ask = vi.fn(async () => ({ suggest: GARAGE }));
    vi.stubGlobal("window", { ogb: { ...windowOn(MY_CLOUD), twoPlaces: { state: ask, accept: ask, dismiss: ask, onChanged: () => () => {} } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    expect(await launch(), "a Cloud's page handed the bridge anyway").not.toContain('data-notice="two-places"');
  });
});
