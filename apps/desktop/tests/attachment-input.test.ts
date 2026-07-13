import assert from "node:assert/strict";
import {
  accountRuntimeImage,
  assertValidImageAttachment,
  MAX_ATTACHMENT_IMAGE_BYTES,
} from "../src/lib/attachmentInput.js";

const valid = {
  name: "geometry.png",
  mime: "image/png",
  size: 75,
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC",
};
assert.doesNotThrow(() => assertValidImageAttachment(valid));
assert.equal(accountRuntimeImage(valid)?.media_type, "image/png");
assert.throws(
  () => assertValidImageAttachment({ ...valid, size: MAX_ATTACHMENT_IMAGE_BYTES + 1 }),
  /no larger than 2 MB/,
);
assert.throws(
  () => assertValidImageAttachment({ ...valid, mime: "image/svg+xml" }),
  /PNG, JPEG, WebP, or GIF/,
);
assert.throws(
  () => assertValidImageAttachment({ ...valid, dataUrl: undefined }),
  /could not be read as image data/,
);
