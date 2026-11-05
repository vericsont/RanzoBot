// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { GoalRunTurnLimitSettings } from "./GoalRunTurnLimitSettings";

const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  api: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(GoalRunTurnLimitSettings)));
const input = () => host.querySelector<HTMLInputElement>("#goal-run-max-turns")!;
const type = (value: string) => {
  const field = input();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
};
const blur = () => flushSync(() => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.config = { goalRuns: { maxTurns: 13 } };
  fixture.dispatch.mockImplementation((action: { type: string; config?: Record<string, unknown> }) => {
    if (action.type === "configStatus") fixture.config = action.config;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("GoalRunTurnLimitSettings", () => {
  it("shows the server's value and saves an odd cap", async () => {
    const saved = { goalRuns: { maxTurns: 15 } };
    fixture.api.mockResolvedValue(saved);
    render();
    expect(input().value).toBe("13");
    type("15");
    blur();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PUT",
      body: JSON.stringify({ goalRuns: { maxTurns: 15 } }),
    });
    await vi.waitFor(() => expect(input().disabled).toBe(false));
    expect(input().value).toBe("15");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("rejects even turn caps without saving", () => {
    render();
    type("14");
    blur();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Enter an odd whole number from 1 to 999.");
  });
});
