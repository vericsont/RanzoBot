import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CloudRoomCardView } from "./CloudRoomCard";
import { PlaceAddSheet } from "./PlaceAddSheet";

const noop = () => {};

afterEach(() => vi.unstubAllGlobals());

it("keeps server and organization choices without offering a Cloud purchase", () => {
  vi.stubGlobal("window", { ogb: {} });
  const html = renderToStaticMarkup(createElement(PlaceAddSheet, {
    choices: { cloud: true, link: true, address: true, organization: true }, onClose: noop,
  }));
  expect(html).toContain('data-place-add-choice="server"');
  expect(html).toContain('data-place-add-choice="organization"');
  expect(html).not.toContain('data-place-add-choice="cloud"');
  const server = renderToStaticMarkup(createElement(PlaceAddSheet, {
    choices: { cloud: true, link: true, address: true }, onClose: noop,
  }));
  expect(server).toContain('data-place-add="own-server"');
});

it("shows resource warnings without prices or upgrade actions", () => {
  const onUpgrade = vi.fn();
  const html = renderToStaticMarkup(createElement(CloudRoomCardView, {
    view: { id: "disk", kind: "disk", title: "Storage is full", cause: "Disk is full", offer: { tier: "max", text: "More disk", price: "$99" }, tip: null },
    upgrade: { busy: null, note: null, onUpgrade }, browser: false, upgraded: null, restart: null, onNotNow: noop, onRestart: noop,
  }));
  expect(html).toContain("Disk is full");
  expect(html).not.toContain("$99");
  expect(html).not.toContain("Upgrade");
  expect(onUpgrade).not.toHaveBeenCalled();
});
