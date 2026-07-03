import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const expectedTag = `v${packageJson.version}`;
const releaseTag = (process.env.MILIM_RELEASE_TAG ?? "").trim();
const eventName = (process.env.GITHUB_EVENT_NAME ?? "").trim();
const refType = (process.env.GITHUB_REF_TYPE ?? "").trim();
const refName = (process.env.GITHUB_REF_NAME ?? "").trim();

if (!releaseTag) {
  fail("MILIM_RELEASE_TAG is required.");
}

if (releaseTag !== expectedTag) {
  fail(`MILIM_RELEASE_TAG must equal package version tag ${expectedTag}, got: ${releaseTag}`);
}

if (eventName !== "workflow_dispatch" && refType && refType !== "tag") {
  fail(`Release workflow must run from tag ref ${releaseTag}, got ${refType} ${refName || "(unknown)"}`);
}

if (eventName !== "workflow_dispatch" && refName && refName !== releaseTag) {
  fail(`Release workflow ref ${refName} must match MILIM_RELEASE_TAG ${releaseTag}`);
}

console.log(`Release tag verified: ${releaseTag}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
