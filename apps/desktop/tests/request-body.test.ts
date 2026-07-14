import assert from "node:assert/strict";
import {
  assertDesktopRequestBodyFits,
  MAX_DESKTOP_REQUEST_BODY_BYTES,
} from "../src/lib/requestBody.js";

assert.doesNotThrow(() => assertDesktopRequestBodyFits("normal request"));
assert.doesNotThrow(() => assertDesktopRequestBodyFits(new Uint8Array(8)));
const oversized = "é".repeat(
  Math.floor(MAX_DESKTOP_REQUEST_BODY_BYTES / 2) + 1,
);
assert.throws(
  () => assertDesktopRequestBodyFits(oversized),
  /This request is too large to send/,
);
