// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { PromptSettings } from "./PromptSettings";

const fixture = vi.hoisted(() => ({
  config: { prompts: { bot: "Default bot prompt", opencode: "Default OpenCode prompt" } },
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

let host: HTMLDivElement;
let root: Root;
const field = (id: string) => host.querySelector<HTMLTextAreaElement>(`#prompt-${id}`)!;
const type = (id: string, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field(id), value);
  flushSync(() => field(id).dispatchEvent(new Event("input", { bubbles: true })));
};
const button = (name: string) => [...host.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name)!;

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.config = { prompts: { bot: "Default bot prompt", opencode: "Default OpenCode prompt" } };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(PromptSettings)));
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("PromptSettings", () => {
  it("shows each current prompt and saves just the edited one", async () => {
    expect(field("bot").value).toBe("Default bot prompt");
    expect(field("opencode").value).toBe("Default OpenCode prompt");
    const saved = { prompts: { bot: "Custom bot prompt", opencode: "Default OpenCode prompt" } };
    fixture.api.mockResolvedValue(saved);
    type("bot", "Custom bot prompt");
    flushSync(() => button("Save bot instructions").click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ prompts: { bot: "Custom bot prompt" } }) }));
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
  });

  it("keeps a draft when another config update arrives", async () => {
    type("bot", "Unsent draft");
    fixture.config = { prompts: { bot: "Changed elsewhere", opencode: "Updated OpenCode" } };
    flushSync(() => root.render(createElement(PromptSettings)));
    expect(field("bot").value).toBe("Unsent draft");
    await vi.waitFor(() => expect(field("opencode").value).toBe("Updated OpenCode"));
  });

  it("restores one default and reports save errors without discarding the draft", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Save failed"));
    type("opencode", "My instructions");
    flushSync(() => button("Save OpenCode instructions").click());
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("Save failed"));
    expect(field("opencode").value).toBe("My instructions");
    fixture.api.mockResolvedValue(fixture.config);
    flushSync(() => button("Reset OpenCode instructions").click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenLastCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ prompts: { opencode: "" } }) }));
    await vi.waitFor(() => expect(field("opencode").value).toBe("Default OpenCode prompt"));
  });
});
