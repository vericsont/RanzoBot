import assert from "node:assert/strict";
import test from "node:test";

import { isRanzoBotBuild } from "./product-identity.mjs";

test("separates RanzoBot from the upstream app identity", () => {
  assert.equal(isRanzoBotBuild("RanzoBot", {}), true);
  assert.equal(isRanzoBotBuild("openmausbot", { RANZOBOT_VARIANT: "1" }), true);
  assert.equal(isRanzoBotBuild("openmausbot", {}), false);
});
