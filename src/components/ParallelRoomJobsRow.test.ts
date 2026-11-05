// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { ParallelRoomJobsRow } from "./AppSettingsRows";

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
const render = (simple = false) => flushSync(() => root.render(createElement(ParallelRoomJobsRow, { simple })));
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-label="Parallel room jobs"]')!;

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.config = { features: { parallelRoomJobs: false } };
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

describe("Parallel room jobs setting", () => {
  it("shows the saved state and enables side-by-side room jobs", async () => {
    const saved = { features: { parallelRoomJobs: true } };
    fixture.api.mockResolvedValue(saved);
    render();
    expect(toggle().getAttribute("aria-checked")).toBe("false");

    flushSync(() => toggle().click());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { parallelRoomJobs: true } }),
    });
    render();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("describes the setting in simple settings", () => {
    render(true);
    expect(host.textContent).toContain("Each member still handles one job at a time.");
  });
});
