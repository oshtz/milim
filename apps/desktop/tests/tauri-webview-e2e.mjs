import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const binary = join(root, "src-tauri", "target", "tauri-verify", "debug", "milim-desktop.exe");
const cdpHost = "127.0.0.1";
const cdpPort = Number(process.env.MILIM_TAURI_E2E_CDP_PORT || 9333);
const cdpUrl = `http://${cdpHost}:${cdpPort}`;
const screenshots = {
  profiles: join(tmpdir(), "milim-tauri-webview-personalized-profiles.png"),
  settings: join(tmpdir(), "milim-tauri-webview-provider-voice-settings.png"),
  chat: join(tmpdir(), "milim-tauri-webview-personalized-chat.png"),
};

const profiles = [
  {
    name: "Code Reviewer",
    avatar: "CR",
    mode: "custom",
    tools: ["read_file", "list_dir", "edit_file"],
    prompt: "Review code for correctness, regressions, missing tests, and concise file-level findings.",
  },
  {
    name: "Security Review",
    avatar: "🛡️",
    mode: "custom",
    tools: ["read_file", "list_dir", "http_fetch"],
    prompt: "Find credential leaks, unsafe commands, weak sandboxing, and external action risks.",
  },
  {
    name: "Prompt Enhancer",
    avatar: "PE",
    mode: "none",
    tools: [],
    prompt: "Improve prompts while preserving constraints, intent, and output shape.",
  },
  {
    name: "Media Workflow Planner",
    avatar: "MW",
    mode: "all",
    tools: [],
    prompt: "Plan image, video, and audio generation workflows with provider choice, queue handling, gallery review, and history checks.",
  },
];

if (process.platform !== "win32") {
  console.log("Skipping Tauri WebView2 E2E: this test currently targets Windows WebView2.");
  process.exit(0);
}

if (!existsSync(binary)) {
  throw new Error(`Tauri binary not found. Run npm run verify:tauri first. Missing: ${binary}`);
}

if (await isPortOpen(cdpPort)) {
  throw new Error(`CDP port ${cdpPort} is already in use.`);
}

const milimHome = mkdtempSync(join(tmpdir(), "milim-tauri-e2e-"));
const consoleErrors = [];
let session;
let failure;

try {
  session = await launchTauri(milimHome);
  await resetFrontendStorage(session.page);
  consoleErrors.push(...(await runProfileSetup(session.page)));
  await session.page.screenshot({ path: screenshots.profiles, fullPage: false });
  consoleErrors.push(...(await runProviderAndVoiceSetup(session.page)));
  await session.page.screenshot({ path: screenshots.settings, fullPage: false });
  await closeSettings(session.page);
  await closeSession(session);
  session = null;
  await waitForPortClosed(cdpPort, 5_000);

  session = await launchTauri(milimHome);
  consoleErrors.push(...(await runPersistenceAndChat(session.page)));
  await session.page.screenshot({ path: screenshots.chat, fullPage: false });

  console.log(`profilesScreenshot=${screenshots.profiles}`);
  console.log(`settingsScreenshot=${screenshots.settings}`);
  console.log(`chatScreenshot=${screenshots.chat}`);

  if (consoleErrors.length) {
    throw new Error(`Console errors during Tauri WebView E2E:\n${consoleErrors.join("\n")}`);
  }
} catch (err) {
  failure = err;
} finally {
  if (session) await closeSession(session).catch(() => {});
  rmWithRetry(milimHome);
}

if (failure) throw failure;

async function runProfileSetup(page) {
  const errors = collectErrors(page);
  await page.getByTestId("chat-shell").waitFor();
  await runWindowPinCheck(page);
  await openAgents(page);

  for (const profile of profiles) {
    await createAgent(page, profile);
  }

  for (const profile of profiles) {
    await page.getByTestId(`agent-editor-${profile.name}`).waitFor();
  }

  await page.getByTestId("agent-editor-Security Review").click();
  await assertFieldContains(page.getByTestId("agent-system-prompt"), "credential leaks");
  await assertToolMode(page, "custom");
  await assertSelectedTools(page, profiles.find((p) => p.name === "Security Review").tools);

  await closeAgents(page);
  await assertAgentOptions(page);
  return errors;
}

async function runPersistenceAndChat(page) {
  const errors = collectErrors(page);
  await page.getByTestId("chat-shell").waitFor();
  await assertAgentOptions(page);
  await assertVoiceSettingsPersisted(page);
  await runAppShortcutCheck(page);

  await runSlashAndAttachmentCheck(page);

  if (await hasChatModel(page)) {
    await selectAgent(page, "Prompt Enhancer");
    await page.getByTestId("composer-input").fill("hello from personalized profile");
    await page.getByTestId("composer-send").click();
    await page.getByTestId("assistant-message").last().waitFor({ timeout: 60_000 });
    await page.getByTestId("assistant-message").last().locator(".msg-text").waitFor({ timeout: 60_000 });
    if (process.env.MILIM_TAURI_E2E_ARTIFACTS === "1") {
      await runArtifactCheck(page);
    } else {
      console.log("artifactGenerationChecks=skipped:set MILIM_TAURI_E2E_ARTIFACTS=1 to run real-model artifact prompts");
    }
  } else {
    console.log("generationChecks=skipped:no chat model configured");
  }

  await openAgentMenu(page);
  await page.getByTestId("manage-agents").click();
  await page.getByTestId("agent-editor-Security Review").click();
  await assertFieldContains(page.getByTestId("agent-system-prompt"), "credential leaks");
  await assertToolMode(page, "custom");
  await assertSelectedTools(page, profiles.find((p) => p.name === "Security Review").tools);
  await closeAgents(page);

  return errors;
}

async function runArtifactCheck(page) {
  const workspace = mkdtempSync(join(tmpdir(), "milim-artifact-workspace-"));
  const prompt = [
    "Return this generated file:",
    "",
    "```ts file=src/e2e-artifact.ts",
    "export const e2eArtifact = true;",
    "```",
  ].join("\n");
  try {
    const savedPath = join(workspace, "src", "e2e-artifact.ts");
    await page.getByTestId("composer-input").fill(`/folder ${workspace}`);
    await page.getByTestId("composer-send").click();
    await page.getByTestId("composer-input").fill(prompt);
    await page.getByTestId("composer-send").click();
    const card = page.getByTestId("artifact-card").last();
    await card.waitFor();
    await card.getByText("src/e2e-artifact.ts").waitFor();
    await card.getByText("export const e2eArtifact = true;").waitFor();
    await card.getByTestId("artifact-copy").waitFor();
    await card.getByTestId("artifact-download").waitFor();
    await card.getByTestId("artifact-review-workspace").click();
    await card.getByTestId("artifact-preview-diff").waitFor();
    await card.getByTestId("artifact-reviewed-time").waitFor();
    await card.getByText("New file preview").waitFor();
    await card.getByText("+export const e2eArtifact = true;").waitFor();
    await card.locator(".artifact-diff-line.added", { hasText: "+export const e2eArtifact = true;" }).waitFor();
    await card.getByTestId("artifact-save-workspace").click();
    await waitForFileText(savedPath, "export const e2eArtifact = true;");
    await card.getByTestId("artifact-saved-path").waitFor();
    await card.getByTestId("artifact-saved-session").getByText("Saved in this app session").waitFor();
    await card.getByTestId("artifact-saved-time").waitFor();
    await card.getByTestId("artifact-open-file").waitFor();
    await card.getByTestId("artifact-open-folder").waitFor();
    writeFileSync(savedPath, "export const e2eArtifact = false;\n", "utf8");
    await card.getByTestId("artifact-save-workspace").click();
    await card.getByTestId("artifact-conflict").waitFor();
    await card.getByTestId("artifact-preview-changes").click();
    await card.getByTestId("artifact-preview-diff").waitFor();
    await card.getByText("-export const e2eArtifact = false;").waitFor();
    await card.getByText("+export const e2eArtifact = true;").waitFor();
    await card.locator(".artifact-diff-line.removed", { hasText: "-export const e2eArtifact = false;" }).waitFor();
    await card.locator(".artifact-diff-line.added", { hasText: "+export const e2eArtifact = true;" }).waitFor();
    await card.locator(".artifact-diff-line.hunk").first().waitFor();
    await card.getByTestId("artifact-preview-apply").click();
    await waitForFileText(savedPath, "export const e2eArtifact = true;");
    await card.getByTestId("artifact-conflict").waitFor({ state: "hidden" });
    await waitForPersistedUserStateText(page, "milim.sessions", savedPath);
    await page.reload();
    await page.getByTestId("chat-shell").waitFor();
    const persistedCard = await waitForArtifactCardWithText(page, savedPath);
    await persistedCard.getByTestId("artifact-saved-path").waitFor();
    await persistedCard.getByText(savedPath).waitFor();
    await persistedCard.getByTestId("artifact-saved-session").getByText("Saved in a previous app session").waitFor();
    await persistedCard.getByTestId("artifact-saved-time").waitFor();
    await persistedCard.getByTestId("artifact-open-file").waitFor();
    await persistedCard.getByTestId("artifact-open-folder").waitFor();
    rmSync(savedPath, { force: true });
    await page.reload();
    await page.getByTestId("chat-shell").waitFor();
    const missingCard = await waitForArtifactCardWithText(page, savedPath);
    await missingCard.getByTestId("artifact-file-missing").waitFor();
    await assertHidden(missingCard.getByTestId("artifact-open-file"), "open file button for missing artifact");
    await assertHidden(missingCard.getByTestId("artifact-open-folder"), "open folder button for missing artifact");
    await missingCard.getByTestId("artifact-save-workspace").click();
    await waitForFileText(savedPath, "export const e2eArtifact = true;");
    await missingCard.getByTestId("artifact-file-missing").waitFor({ state: "hidden" });
    await missingCard.getByTestId("artifact-open-file").waitFor();
    await missingCard.getByTestId("artifact-open-folder").waitFor();
    await runPerArtifactUnchangedCheck(missingCard);
    await runBatchArtifactCheck(page, workspace);
    await runBatchArtifactSelectionCheck(page, workspace);
    await runBatchArtifactUnchangedCheck(page, workspace);
    await runBatchArtifactFailureCheck(page, workspace);
    await runArtifactTargetPathCheck(page, workspace);
    await runLargeArtifactDiffCheck(page, workspace);
    await runArtifactPreviewPanelCheck(page);
  } finally {
    rmWithRetry(workspace);
  }
}

async function runArtifactPreviewPanelCheck(page) {
  const prompt = [
    "Return exactly this two-file artifact:",
    "",
    "```html file=index.html",
    '<!doctype html><html><body><div id="app"></div><script type="module" src="./src/main.js"></script></body></html>',
    "```",
    "```js file=src/main.js",
    'console.log("artifact log ready");',
    'throw new Error("artifact boom");',
    "```",
  ].join("\n");
  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-send").click();
  const indexCard = page.getByTestId("artifact-card").filter({ hasText: "index.html" }).last();
  await indexCard.waitFor({ timeout: 60_000 });
  await indexCard.getByTestId("artifact-open-preview").click();
  const preview = page.getByTestId("chat-preview-split");
  await preview.waitFor();
  await assertHidden(preview.getByTestId("preview-code-file-list"), "code file list in preview mode");
  await preview.getByTestId("preview-log-drawer").waitFor();
  await preview.getByTestId("preview-log-list").getByText("artifact boom").waitFor({ timeout: 20_000 });
  await preview.getByTestId("preview-tab-code").click();
  await preview.getByTestId("preview-code-file-list").waitFor();
  await preview.getByTestId("preview-code-line-number").filter({ hasText: "1" }).first().waitFor();
  const before = await preview.getByTestId("preview-code-file-list").boundingBox();
  const handle = await preview.getByTestId("preview-code-resize-handle").boundingBox();
  if (!before || !handle) throw new Error("Preview code splitter should have measurable bounds.");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2);
  await page.mouse.up();
  const after = await preview.getByTestId("preview-code-file-list").boundingBox();
  if (!after || after.width <= before.width) {
    throw new Error(`Preview file list should resize wider, before=${before?.width}, after=${after?.width}`);
  }
  await preview.getByTestId("preview-tab-preview").click();
  await preview.getByTestId("preview-quick-fix").click();
  await page.getByTestId("user-message").last().getByText("Please fix the current artifact preview errors.").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Stop generating" }).click().catch(() => {});
}

async function runPerArtifactUnchangedCheck(card) {
  await card.getByTestId("artifact-review-workspace").click();
  await card.getByTestId("artifact-unchanged").waitFor();
  await card.getByText("No changes").waitFor();
  await assertHidden(card.getByTestId("artifact-preview-apply"), "apply button for unchanged artifact");
}

async function runBatchArtifactCheck(page, workspace) {
  const existingPath = join(workspace, "src", "batch-one.ts");
  const newPath = join(workspace, "src", "batch-two.ts");
  writeFileSync(existingPath, "export const batchOne = false;\n", "utf8");
  rmSync(newPath, { force: true });

  const prompt = [
    "Return this two-file change set:",
    "",
    "```ts file=src/batch-one.ts",
    "export const batchOne = true;",
    "```",
    "",
    "```ts file=src/batch-two.ts",
    "export const batchTwo = true;",
    "```",
  ].join("\n");

  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-send").click();
  const list = page.getByTestId("artifact-list").last();
  await list.getByTestId("artifact-batch-review").waitFor();
  await list.getByTestId("artifact-card").filter({ hasText: "src/batch-one.ts" }).waitFor();
  await list.getByTestId("artifact-card").filter({ hasText: "src/batch-two.ts" }).waitFor();
  await list.getByTestId("artifact-batch-review").click();
  await list.getByText("2 artifacts reviewed").waitFor();
  await list.getByText("-export const batchOne = false;").waitFor();
  await list.getByText("+export const batchOne = true;").waitFor();
  await list.getByText("+export const batchTwo = true;").waitFor();
  await list.getByTestId("artifact-batch-apply").click();
  await list.getByText("2 artifacts applied.").waitFor();
  await waitForFileText(existingPath, "export const batchOne = true;");
  await waitForFileText(newPath, "export const batchTwo = true;");
  const firstResultRow = list.getByTestId("artifact-batch-result").filter({ hasText: "batch-one.ts" });
  await firstResultRow.getByTestId("artifact-batch-open-file").waitFor();
  await firstResultRow.getByTestId("artifact-batch-open-folder").waitFor();
  const secondResultRow = list.getByTestId("artifact-batch-result").filter({ hasText: "batch-two.ts" });
  await secondResultRow.getByTestId("artifact-batch-open-file").waitFor();
  await secondResultRow.getByTestId("artifact-batch-open-folder").waitFor();
}

async function runBatchArtifactSelectionCheck(page, workspace) {
  const selectedPath = join(workspace, "src", "batch-selected.ts");
  const skippedPath = join(workspace, "src", "batch-skipped.ts");
  rmSync(selectedPath, { force: true });
  rmSync(skippedPath, { force: true });

  const prompt = [
    "Return this two-file change set:",
    "",
    "```ts file=src/batch-selected.ts",
    "export const batchSelected = true;",
    "```",
    "",
    "```ts file=src/batch-skipped.ts",
    "export const batchSkipped = true;",
    "```",
  ].join("\n");

  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-send").click();
  const list = page.getByTestId("artifact-list").last();
  await list.getByTestId("artifact-batch-apply").waitFor();
  const selectedCard = list.getByTestId("artifact-card").filter({ hasText: "src/batch-selected.ts" });
  const skippedCard = list.getByTestId("artifact-card").filter({ hasText: "src/batch-skipped.ts" });
  await selectedCard.waitFor();
  await skippedCard.waitFor();
  await skippedCard.getByTestId("artifact-select-toggle").click();
  await assertAttribute(skippedCard.getByTestId("artifact-select-toggle"), "aria-checked", "false");
  await assertAttribute(selectedCard.getByTestId("artifact-select-toggle"), "aria-checked", "true");
  await list.getByTestId("artifact-batch-selection-count").getByText("1 of 2 selected").waitFor();
  await list.getByTestId("artifact-batch-review").click();
  await list.getByText("1 artifact reviewed; 1 changed.").waitFor();
  await selectedCard.getByTestId("artifact-preview-diff").waitFor();
  await assertHidden(skippedCard.getByTestId("artifact-preview-diff"), "deselected artifact preview diff");
  await list.getByTestId("artifact-batch-apply").click();
  await list.getByText("1 artifact applied.").waitFor();
  await waitForFileText(selectedPath, "export const batchSelected = true;");
  if (existsSync(skippedPath)) {
    throw new Error("Deselected batch artifact should not be written.");
  }
  await list.getByTestId("artifact-batch-result").filter({ hasText: "batch-selected.ts" }).getByText("Applied").waitFor();
  if (await list.getByTestId("artifact-batch-result").filter({ hasText: "batch-skipped.ts" }).isVisible().catch(() => false)) {
    throw new Error("Deselected batch artifact should not appear in batch results.");
  }
}

async function runBatchArtifactUnchangedCheck(page, workspace) {
  const changedPath = join(workspace, "src", "batch-change-needed.ts");
  const unchangedPath = join(workspace, "src", "batch-unchanged.ts");
  writeFileSync(changedPath, "export const batchChangeNeeded = false;\n", "utf8");
  writeFileSync(unchangedPath, "export const batchUnchanged = true;", "utf8");
  const unchangedMtimeBefore = statSync(unchangedPath).mtimeMs;
  await delay(1200);

  const prompt = [
    "Return this two-file change set:",
    "",
    "```ts file=src/batch-change-needed.ts",
    "export const batchChangeNeeded = true;",
    "```",
    "",
    "```ts file=src/batch-unchanged.ts",
    "export const batchUnchanged = true;",
    "```",
  ].join("\n");

  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-send").click();
  const list = page.getByTestId("artifact-list").last();
  await list.getByTestId("artifact-batch-review").waitFor();
  await list.getByTestId("artifact-card").filter({ hasText: "src/batch-change-needed.ts" }).waitFor();
  await list.getByTestId("artifact-card").filter({ hasText: "src/batch-unchanged.ts" }).waitFor();
  await list.getByTestId("artifact-batch-review").click();
  await list.getByText("2 artifacts reviewed; 1 changed, 1 unchanged.").waitFor();
  await list.getByTestId("artifact-batch-apply").click();
  await list.getByText("1 applied; 1 unchanged.").waitFor();
  await waitForFileText(changedPath, "export const batchChangeNeeded = true;");
  const unchangedMtimeAfter = statSync(unchangedPath).mtimeMs;
  if (unchangedMtimeAfter !== unchangedMtimeBefore) {
    throw new Error("Unchanged batch artifact should not be rewritten.");
  }
  await list.getByTestId("artifact-batch-result").filter({ hasText: "batch-change-needed.ts" }).getByText("Applied").waitFor();
  const unchangedRow = list.getByTestId("artifact-batch-result").filter({ hasText: "batch-unchanged.ts" });
  const unchangedRowText = await unchangedRow.innerText();
  if (!unchangedRowText.includes("Unchanged")) {
    throw new Error(`Expected unchanged batch result row, got: ${unchangedRowText}`);
  }
  await unchangedRow.getByTestId("artifact-batch-open-file").waitFor();
  await unchangedRow.getByTestId("artifact-batch-open-folder").waitFor();
}

async function runBatchArtifactFailureCheck(page, workspace) {
  const okPath = join(workspace, "src", "batch-ok.ts");
  const blockedOriginalPath = join(workspace, "src", "batch-blocked.ts");
  rmSync(okPath, { force: true });
  rmSync(blockedOriginalPath, { force: true });

  const prompt = [
    "Return this two-file change set:",
    "",
    "```ts file=src/batch-ok.ts",
    "export const batchOk = true;",
    "```",
    "",
    "```ts file=src/batch-blocked.ts",
    "export const batchBlocked = true;",
    "```",
  ].join("\n");

  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-send").click();
  const list = page.getByTestId("artifact-list").last();
  await list.getByTestId("artifact-batch-apply").waitFor();
  await list.getByTestId("artifact-card").filter({ hasText: "src/batch-ok.ts" }).waitFor();
  const blockedCard = list.getByTestId("artifact-card").filter({ hasText: "src/batch-blocked.ts" });
  await blockedCard.getByTestId("artifact-target-path").fill("../blocked-batch.ts");
  await list.getByTestId("artifact-batch-apply").click();
  await waitForFileText(okPath, "export const batchOk = true;");
  if (existsSync(blockedOriginalPath)) {
    throw new Error("Failed batch artifact should not write its original generated path.");
  }
  await list.getByText("1 applied; 1 failed.").waitFor();
  await list.getByTestId("artifact-batch-results").waitFor();
  await list.getByTestId("artifact-batch-result").filter({ hasText: "batch-ok.ts" }).getByText("Applied").waitFor();
  const failedRow = list.getByTestId("artifact-batch-result").filter({ hasText: "blocked-batch.ts" });
  await failedRow.getByText("Failed").waitFor();
  await assertHidden(failedRow.getByTestId("artifact-batch-open-file"), "open file action for failed batch result");
  await assertHidden(failedRow.getByTestId("artifact-batch-open-folder"), "open folder action for failed batch result");
  await blockedCard.getByTestId("artifact-error").waitFor();
}

async function runArtifactTargetPathCheck(page, workspace) {
  const originalPath = join(workspace, "src", "target-original.ts");
  const renamedPath = join(workspace, "src", "target-renamed.ts");
  rmSync(originalPath, { force: true });
  rmSync(renamedPath, { force: true });

  const prompt = [
    "Return this generated file:",
    "",
    "```ts file=src/target-original.ts",
    "export const targetPath = true;",
    "```",
  ].join("\n");

  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-send").click();
  const card = page.getByTestId("artifact-card").last();
  await card.getByText("src/target-original.ts").waitFor();
  await card.getByTestId("artifact-target-path").fill("src/target-renamed.ts");
  await card.getByTestId("artifact-save-workspace").click();
  await waitForFileText(renamedPath, "export const targetPath = true;");
  if (existsSync(originalPath)) {
    throw new Error("Target override should not write the original artifact path.");
  }
  await card.getByTestId("artifact-saved-path").waitFor();
  await card.getByText(renamedPath).waitFor();
  await card.getByTestId("artifact-target-path").fill("../blocked.ts");
  await card.getByTestId("artifact-save-workspace").click();
  await card.getByTestId("artifact-error").waitFor();
  await card.getByText("..").waitFor();
  await card.getByText("artifact paths").waitFor();
}

async function runLargeArtifactDiffCheck(page, workspace) {
  const largePath = join(workspace, "src", "large-diff.ts");
  const oldLines = numberedLargeLines(false);
  const newLines = numberedLargeLines(true);
  writeFileSync(largePath, `${oldLines.join("\n")}\n`, "utf8");

  const prompt = [
    "Return this generated file:",
    "",
    "```ts file=src/large-diff.ts",
    ...newLines,
    "```",
  ].join("\n");

  await page.getByTestId("composer-input").fill(prompt);
  await page.getByTestId("composer-send").click();
  const card = page.getByTestId("artifact-card").last();
  await card.getByText("src/large-diff.ts").waitFor();
  await card.getByTestId("artifact-review-workspace").click();
  await card.getByTestId("artifact-preview-diff").waitFor();
  await card.getByTestId("artifact-diff-summary").waitFor();
  const summary = await card.getByTestId("artifact-diff-summary").innerText();
  if (!/\d+ added, \d+ removed/.test(summary)) {
    throw new Error(`Expected large diff summary to include added/removed counts, got: ${summary}`);
  }
  await card.getByTestId("artifact-diff-toggle").waitFor();
  const diffLines = card.locator(".artifact-diff-line");
  const collapsedLineCount = await diffLines.count();
  if (collapsedLineCount > 85) {
    throw new Error(`Expected collapsed large diff to render a bounded line count, got ${collapsedLineCount}.`);
  }
  await card.getByTestId("artifact-diff-toggle").click();
  await waitForLocatorCountGreaterThan(diffLines, collapsedLineCount);
  await card.getByTestId("artifact-diff-toggle").click();
  await waitForLocatorCountAtMost(diffLines, collapsedLineCount);
}

function numberedLargeLines(value) {
  return Array.from({ length: 120 }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    return `export const largeLine${n} = ${value};`;
  });
}

async function runSlashAndAttachmentCheck(page) {
  await page.getByTestId("composer-input").fill("/privacy redact");
  await page.getByTestId("composer-send").click();
  await page.getByTestId("context-menu-trigger").waitFor();
  await page.getByTestId("context-menu-trigger").click();
  const privacyRow = page.locator(".context-row", { hasText: "Private mode" });
  await privacyRow.locator(".context-value", { hasText: "Redact" }).waitFor();
  await page.getByTestId("composer-input").click();

  const attachmentPath = join(tmpdir(), `milim-e2e-attachment-${Date.now()}.txt`);
  writeFileSync(attachmentPath, "attached context from webview e2e\n", "utf8");
  try {
    await page.getByTestId("composer-file-input").setInputFiles(attachmentPath);
    const tray = page.getByTestId("attachment-tray");
    await tray.waitFor();
    await tray.getByText("milim-e2e-attachment").waitFor();
    await pasteFileIntoComposer(page, "pasted-screenshot.png", "image/png", "fake-png-bytes");
    await tray.getByText("pasted-screenshot.png").waitFor();
    await tray.locator(".attachment-thumb").waitFor();
    if (!(await hasChatModel(page))) {
      console.log("attachmentSendCheck=skipped:no chat model configured");
      await clearAttachments(page);
      return;
    }
    await page.getByTestId("composer-input").fill("read the attached note");
    await page.getByTestId("composer-send").click();
    const sentMessage = page.getByTestId("user-message").last();
    await waitForLocatorCountGreaterThan(sentMessage.locator('[data-testid^="message-attachment-"]'), 1);
    await sentMessage.getByText("milim-e2e-attachment").waitFor();
    await sentMessage.getByText("pasted-screenshot.png").waitFor();
    await sentMessage.getByText("read the attached note").waitFor();
  } finally {
    rmSync(attachmentPath, { force: true });
  }
}

async function pasteFileIntoComposer(page, name, type, content) {
  await page.getByTestId("composer-input").evaluate(
    (el, payload) => {
      const file = new File([payload.content], payload.name, { type: payload.type });
      const data = new DataTransfer();
      data.items.add(file);
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      el.dispatchEvent(event);
    },
    { name, type, content },
  );
}

async function hasChatModel(page) {
  const label = await page.getByTestId("model-picker-trigger").locator(".chip-label").innerText().catch(() => "");
  const normalized = label.trim().toLowerCase();
  return Boolean(normalized && normalized !== "choose model" && normalized !== "no model" && normalized !== "model");
}

async function clearAttachments(page) {
  const buttons = page.locator(".attachment-remove");
  while ((await buttons.count()) > 0) {
    await buttons.first().click();
  }
  await page.getByTestId("composer-input").fill("");
}

async function runProviderAndVoiceSetup(page) {
  const errors = collectErrors(page);
  await page.getByTestId("chat-shell").waitFor();

  await openProviders(page);
  await assertTextContains(page.getByTestId("provider-readiness"), "Hosted");
  await assertTextContains(page.getByTestId("provider-readiness"), "Not set");
  await page.getByTestId("detect-local-providers").click();
  await page.getByText("Ollama (local)").waitFor({ timeout: 20_000 });
  await page.getByText("LM Studio (local)").waitFor({ timeout: 20_000 });
  await page.getByTestId("new-provider").click();
  await page.getByTestId("provider-name-input").fill("E2E Local Provider");
  await page.getByTestId("provider-kind-select").click();
  await page.locator(".providers-sheet .ui-select-menu .ui-select-item", { hasText: "OpenAI-compatible" }).click();
  await page.getByTestId("provider-base-url-input").fill("http://127.0.0.1:9/v1");
  await page.getByTestId("provider-api-key-input").fill("e2e-key");
  await assertFieldContains(page.getByTestId("provider-name-input"), "E2E Local Provider");
  await assertFieldContains(page.getByTestId("provider-base-url-input"), "127.0.0.1:9");

  await page.getByTestId("new-provider").click();
  await page.getByTestId("provider-preset-select").click();
  await page.locator(".providers-sheet .ui-select-menu .ui-select-item", { hasText: "fal" }).click();
  await page.getByTestId("provider-api-key-input").fill("fal-e2e-key");
  await page.getByTestId("save-provider").click();
  await page.getByText("Media provider saved").waitFor();
  await closeProviders(page);

  await page.getByTestId("model-picker-trigger").click();
  await page.locator(".mp-item", { hasText: "fal-ai/flux/schnell" }).locator(".mp-pick").click();
  await page.getByTestId("inline-media-generator").waitFor();
  await assertAttributeContains(page.getByTestId("inline-media-generator"), "title", "fal-ai/flux/schnell");
  await page.getByTestId("composer-input").fill("studio product photo");

  await openSettings(page);
  await page.getByTestId("settings-section-audio").click();
  await setSwitch(page.getByTestId("voice-enabled-toggle"), true, "voice enabled");
  await setSwitch(page.getByTestId("voice-hotkey-toggle"), true, "voice hotkey");
  await page.getByTestId("voice-hotkey-shortcut").fill("CommandOrControl+Alt+Space");
  await setSwitch(page.getByTestId("voice-dictation-toggle"), true, "voice dictation");
  await assertFieldContains(page.getByTestId("voice-hotkey-shortcut"), "CommandOrControl+Alt+Space");
  await runVoiceAndTtsSettingsCheck(page);
  await runAppShortcutSettingsCheck(page);

  return errors;
}

async function resetFrontendStorage(page) {
  await page.getByTestId("chat-shell").waitFor();
  await page.evaluate(() => {
    for (const key of [
      "milim.sessions",
      "milim.settings",
      "milim.ui",
      "milim.window.alwaysOnTop",
    ]) {
      window.localStorage.removeItem(key);
    }
  });
  await page.reload();
  await page.getByTestId("chat-shell").waitFor();
}

async function runWindowPinCheck(page) {
  const pin = page.getByTestId("pin-window");
  await pin.waitFor();
  if ((await pin.getAttribute("aria-pressed")) !== "false") {
    await pin.click();
  }
  await pin.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="pin-window"]')?.getAttribute("aria-pressed") === "true");
  await pin.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="pin-window"]')?.getAttribute("aria-pressed") === "false");
}

async function openAgents(page) {
  await page.getByTestId("agent-switcher").click();
  await page.getByTestId("manage-agents").click();
}

async function closeAgents(page) {
  await page.getByTestId("close-agents").click();
}

async function openProviders(page) {
  await page.getByTestId("model-picker-trigger").click();
  await page.getByTestId("manage-providers").click();
  await page.getByTestId("provider-readiness").waitFor();
}

async function closeProviders(page) {
  await page.getByTestId("close-providers").click();
}

async function openSettings(page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-section-audio").waitFor();
}

async function closeSettings(page) {
  await page.getByTestId("close-settings").click();
}

async function assertVoiceSettingsPersisted(page) {
  await openSettings(page);
  await page.getByTestId("settings-section-audio").click();
  await assertSwitch(page.getByTestId("voice-enabled-toggle"), true, "voice enabled");
  await assertSwitch(page.getByTestId("voice-hotkey-toggle"), true, "voice hotkey");
  await assertSwitch(page.getByTestId("voice-dictation-toggle"), true, "voice dictation");
  await assertFieldContains(page.getByTestId("voice-hotkey-shortcut"), "CommandOrControl+Alt+Space");
  await assertAppShortcutsPersisted(page);
  await closeSettings(page);
}

async function runAppShortcutSettingsCheck(page) {
  await page.getByTestId("settings-section-system").click();
  await page.getByTestId("app-shortcut-stopGeneration").click();
  await page.keyboard.press("F2");
  await shortcutRow(page, "stopGeneration").getByText("F2").waitFor();
}

async function assertAppShortcutsPersisted(page) {
  await page.getByTestId("settings-section-system").click();
  await shortcutRow(page, "newChat").getByText("Ctrl+N").waitFor();
  await shortcutRow(page, "focusSearch").getByText("Ctrl+K").waitFor();
  await shortcutRow(page, "focusComposer").getByText("Ctrl+L").waitFor();
  await shortcutRow(page, "stopGeneration").getByText("F2").waitFor();
  await shortcutRow(page, "toggleSidebar").getByText("Ctrl+B").waitFor();
  await shortcutRow(page, "previousThread").getByText("Ctrl+Tab").waitFor();
}

function shortcutRow(page, action) {
  return page.locator(".shortcut-recorder-row", { has: page.getByTestId(`app-shortcut-${action}`) });
}

async function runVoiceAndTtsSettingsCheck(page) {
  await page.getByTestId("settings-section-audio").click();
  const vadSwitch = page.locator(".setting-toggle-row", { hasText: "Server speech preflight" }).getByRole("switch");
  await setSwitch(vadSwitch, true, "server speech preflight");
  await page.getByRole("button", { name: "Native ONNX" }).click();
  await page.getByText("VAD presets").waitFor();
  await page.getByText("Silero VAD").waitFor();
  await page.getByText("Native VAD model path is required.").waitFor();

  await page.getByTestId("audio-output-tab").click();
  const ttsSwitch = page.getByTestId("tts-enabled-toggle");
  await setSwitch(ttsSwitch, true, "text-to-speech");
  await page.locator(".tts-provider-grid .stt-card", { hasText: "Run a local Piper executable" }).click();
  await page.getByText("Piper presets").waitFor();
  await page.getByText("en_US-lessac-medium").waitFor();
  await page.getByText("Piper command is required.").waitFor();

  await page.locator(".tts-provider-grid .stt-card", { hasText: "Prepare in-process Piper ONNX" }).click();
  await page.getByText("Native TTS model path is required.").waitFor();
  await page.getByRole("button", { name: "Kokoro", exact: true }).click();
  await page.getByText("Kokoro presets").waitFor();
  await page.getByText("Kokoro q8f16 af_alloy").waitFor();
}

async function runAppShortcutCheck(page) {
  await seedChatSearchFixture(page);
  await page.getByTestId("composer-input").fill("shortcut draft");
  await page.keyboard.press("Control+B");
  await page.getByTestId("sidebar-search").waitFor({ state: "hidden" });
  await page.keyboard.press("Control+B");
  await page.getByTestId("sidebar-search").waitFor();

  await page.keyboard.press("Control+K");
  await page.getByTestId("chat-search-input").waitFor();
  await expectFocusedTestId(page, "chat-search-input");
  await page.getByTestId("chat-search-input").fill("volcano ledger");
  await page.getByTestId("chat-search-result").filter({ hasText: "Older Search Fixture" }).waitFor();
  await page.keyboard.press("Enter");
  await page.getByTestId("chat-search-input").waitFor({ state: "hidden" });
  await page.getByTestId("user-message").filter({ hasText: "volcano ledger phrase" }).waitFor();
  await page.keyboard.press("Control+Tab");
  await page.getByTestId("user-message").filter({ hasText: "volcano ledger phrase" }).waitFor({ state: "hidden" });
  await page.keyboard.press("Control+Tab");
  await page.getByTestId("user-message").filter({ hasText: "volcano ledger phrase" }).waitFor();
  await page.keyboard.press("Control+K");
  await page.getByTestId("chat-search-input").waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("chat-search-input").waitFor({ state: "hidden" });
  await page.keyboard.press("Control+L");
  await expectFocusedTestId(page, "composer-input");
  await page.keyboard.press("Control+N");
  await expectFocusedTestId(page, "composer-input");
  const value = await page.getByTestId("composer-input").inputValue();
  if (value !== "") throw new Error(`Expected Ctrl+N to clear composer, got "${value}".`);
}

async function seedChatSearchFixture(page) {
  await page.evaluate(async () => {
    const key = "milim.sessions";
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    const raw = invoke ? await invoke("user_state_get", { key }) : window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : { state: {} };
    const state = parsed.state && typeof parsed.state === "object" ? parsed.state : {};
    const now = Date.now();
    const current = {
      id: "e2e-current-chat",
      title: "New chat",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    const existingSessions = Array.isArray(state.sessions) ? state.sessions : [];
    const sessions = (existingSessions.length ? existingSessions : [current]).filter((session) => session && session.id !== "e2e-search-fixture");
    sessions.push({
      id: "e2e-search-fixture",
      title: "Older Search Fixture",
      messages: [
        { role: "user", content: "The volcano ledger phrase lives in this older message." },
      ],
      createdAt: now - 7 * 24 * 60 * 60 * 1000,
      updatedAt: now - 7 * 24 * 60 * 60 * 1000,
    });
    state.sessions = sessions;
    if (!sessions.some((session) => session.id === state.activeId)) state.activeId = sessions[0].id;
    parsed.state = state;
    const value = JSON.stringify(parsed);
    if (invoke) await invoke("user_state_set", { key, value });
    else window.localStorage.setItem(key, value);
  });
  await page.reload();
  await page.getByTestId("chat-shell").waitFor();
}

async function assertAgentOptions(page) {
  await openAgentMenu(page);
  for (const profile of profiles) {
    await page.getByTestId(`agent-option-${profile.name}`).waitFor();
  }
  await closeAgentMenu(page);
}

async function selectAgent(page, name) {
  await openAgentMenu(page);
  await page.getByTestId(`agent-option-${name}`).click();
}

async function openAgentMenu(page) {
  const firstOption = page.getByTestId(`agent-option-${profiles[0].name}`);
  if (!(await firstOption.isVisible().catch(() => false))) {
    await page.getByTestId("agent-switcher").click();
  }
  await firstOption.waitFor();
}

async function closeAgentMenu(page) {
  if (await page.getByTestId(`agent-option-${profiles[0].name}`).isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await page.getByTestId(`agent-option-${profiles[0].name}`).waitFor({ state: "hidden" });
  }
}

async function createAgent(page, profile) {
  await page.getByTestId("new-agent").click();
  await page.getByTestId("agent-name-input").fill(profile.name);

  if (profile.avatar) {
    await page.getByTestId("agent-avatar-input").fill(profile.avatar);
  }

  await page.getByTestId("agent-system-prompt").fill(profile.prompt);

  if (profile.mode === "custom") {
    await setCustomTools(page, profile.tools);
  } else {
    await page.getByTestId(`tool-mode-${profile.mode}`).click();
  }

  await page.getByTestId("save-agent").click();
  await page.getByTestId(`agent-editor-${profile.name}`).waitFor();
}

async function setCustomTools(page, wantedTools) {
  const wanted = new Set(wantedTools);
  await page.getByTestId("tool-mode-custom").click();
  await page.getByTestId("tool-search").fill("");
  const rows = await page.locator(".tool-row").all();
  if (rows.length === 0) throw new Error("Expected custom tool rows to be visible.");

  for (const row of rows) {
    const name = (await row.locator(".tool-name").innerText()).trim();
    const checkbox = row.getByRole("checkbox");
    const checked = (await checkbox.getAttribute("aria-checked")) === "true";
    const shouldBeChecked = wanted.has(name);
    if (checked !== shouldBeChecked) {
      await checkbox.click();
    }
  }

  await assertSelectedTools(page, wantedTools);
}

async function assertSelectedTools(page, wantedTools) {
  const wanted = new Set(wantedTools);
  await page.getByTestId("tool-search").fill("");
  for (const tool of wanted) {
    await page.getByTestId(`tool-row-${tool}`).waitFor();
  }
  const rows = await page.locator(".tool-row").all();
  const seen = new Map();

  for (const row of rows) {
    const name = (await row.locator(".tool-name").innerText()).trim();
    const checkbox = row.getByRole("checkbox");
    const checked = (await checkbox.getAttribute("aria-checked")) === "true";
    seen.set(name, checked);
  }

  for (const tool of wanted) {
    if (seen.get(tool) !== true) throw new Error(`Expected tool ${tool} to be selected.`);
  }

  for (const [tool, checked] of seen) {
    if (!wanted.has(tool) && checked) throw new Error(`Expected tool ${tool} to be deselected.`);
  }
}

async function assertToolMode(page, mode) {
  const classes = await page.getByTestId(`tool-mode-${mode}`).getAttribute("class");
  if (!classes?.includes("active")) throw new Error(`Expected tool mode ${mode} to be active.`);
}

async function assertFieldContains(locator, text) {
  const value = await locator.inputValue();
  if (!value.includes(text)) throw new Error(`Expected field to contain "${text}".`);
}

async function assertTextContains(locator, text) {
  const value = await locator.innerText();
  if (!value.includes(text)) throw new Error(`Expected text to contain "${text}".`);
}

async function assertAttributeContains(locator, attribute, text) {
  const value = await locator.getAttribute(attribute);
  if (!value?.includes(text)) throw new Error(`Expected ${attribute} to contain "${text}".`);
}

async function expectFocusedTestId(page, testId) {
  await page.waitForFunction((expected) => document.activeElement?.getAttribute("data-testid") === expected, testId);
}

async function assertTextContainsIgnoreCase(locator, text) {
  const value = await locator.innerText();
  if (!value.toLowerCase().includes(text.toLowerCase())) {
    throw new Error(`Expected text to contain "${text}" ignoring case, got "${value}".`);
  }
}

async function waitForArtifactCardWithText(page, text) {
  const card = page.getByTestId("artifact-card").filter({ hasText: text });
  await card.waitFor({ timeout: 30_000 });
  return card;
}

async function waitForPersistedUserStateText(page, key, text, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await page.evaluate(async ({ key, text }) => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      const value = invoke ? await invoke("user_state_get", { key }) : window.localStorage.getItem(key);
      if (typeof value !== "string") return false;
      try {
        const parsed = JSON.parse(value);
        const containsText = (item) => {
          if (typeof item === "string") return item.includes(text);
          if (Array.isArray(item)) return item.some(containsText);
          if (item && typeof item === "object") return Object.values(item).some(containsText);
          return false;
        };
        return containsText(parsed);
      } catch {
        return value.includes(text) || value.includes(text.replaceAll("\\", "\\\\"));
      }
    }, { key, text });
    if (found) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for persisted ${key} to include ${text}.`);
}

async function assertHidden(locator, label) {
  if (await locator.isVisible().catch(() => false)) {
    throw new Error(`Expected ${label} to be hidden.`);
  }
}

async function assertAttribute(locator, name, expected) {
  const value = await locator.getAttribute(name);
  if (value !== expected) throw new Error(`Expected ${name} to be "${expected}", got "${value}".`);
}

async function waitForTestIdTextContainsIgnoreCase(page, testId, text) {
  await page.waitForFunction(
    ([testId, expected]) => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      return el?.textContent?.toLowerCase().includes(expected.toLowerCase());
    },
    [testId, text],
  );
}

async function waitForFileText(path, expected, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(expected)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path} to contain ${expected}`);
}

async function waitForLocatorCountGreaterThan(locator, minCount, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const count = await locator.count();
    if (count > minCount) return count;
    await delay(100);
  }
  throw new Error(`Timed out waiting for locator count to exceed ${minCount}.`);
}

async function waitForLocatorCountAtMost(locator, maxCount, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const count = await locator.count();
    if (count <= maxCount) return count;
    await delay(100);
  }
  throw new Error(`Timed out waiting for locator count to return to ${maxCount} or less.`);
}

async function setSwitch(locator, checked, label) {
  const current = (await locator.getAttribute("aria-checked")) === "true";
  if (current !== checked) await locator.click();
  await assertSwitch(locator, checked, label);
}

async function assertSwitch(locator, checked, label) {
  const current = (await locator.getAttribute("aria-checked")) === "true";
  if (current !== checked) throw new Error(`Expected ${label} switch to be ${checked ? "on" : "off"}.`);
}

function collectErrors(page) {
  const errors = [];
  const expectedFailedResources = [];
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() === 502 && /\/media\/(?:models|model-schema)\b/.test(url)) {
      expectedFailedResources.push(url);
    }
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const url = msg.location().url;
    if (text === "Failed to load resource: the server responded with a status of 502 (Bad Gateway)") {
      const responseIndex = expectedFailedResources.findIndex((resourceUrl) => !url || resourceUrl === url);
      if (/\/media\/(?:models|model-schema)\b/.test(url) || responseIndex >= 0) {
        if (responseIndex >= 0) expectedFailedResources.splice(responseIndex, 1);
        return;
      }
    }
    errors.push(url ? `${text} (${url})` : text);
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function launchTauri(milimHome) {
  const child = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      MILIM_HOME: milimHome,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: appendWebViewArg(
        process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
        `--remote-debugging-port=${cdpPort}`,
      ),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const session = { child, stdout: "", stderr: "", browser: null, page: null };
  child.stdout?.on("data", (chunk) => {
    session.stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    session.stderr += chunk.toString();
  });

  await waitForCdp(session, cdpUrl, 20_000);
  session.browser = await chromium.connectOverCDP(cdpUrl);
  const context = session.browser.contexts()[0] ?? await session.browser.newContext();
  session.page = await firstPage(context);
  session.page.setDefaultTimeout(10_000);
  return session;
}

async function closeSession(session) {
  await session.page?.locator(".win-close").click({ timeout: 1_000 }).catch(() => {});
  await waitForExit(session.child, 2_500).catch(() => {});
  await session.browser?.close().catch(() => {});
  if (session.child.exitCode == null) {
    killTree(session.child.pid);
    await waitForExit(session.child, 5_000).catch(() => {});
  }
}

function appendWebViewArg(existing, arg) {
  const trimmed = existing?.trim();
  return trimmed ? `${trimmed} ${arg}` : arg;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPortClosed(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await isPortOpen(port))) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for port ${port} to close.`);
}

async function waitForCdp(session, url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (session.child.exitCode != null) {
      throw new Error(`Tauri exited before CDP was ready.\nstdout:\n${session.stdout}\nstderr:\n${session.stderr}`);
    }
    try {
      const resp = await fetch(`${url}/json/version`);
      if (resp.ok) return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for ${url}/json/version.\nstdout:\n${session.stdout}\nstderr:\n${session.stderr}`);
}

async function firstPage(context) {
  for (const page of context.pages()) {
    if (!page.isClosed()) return page;
  }
  return await context.waitForEvent("page", { timeout: 10_000 });
}

function killTree(pid) {
  if (!pid) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

function waitForExit(proc, timeoutMs) {
  if (proc.exitCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Tauri process exit")), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function rmWithRetry(path) {
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === 4) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
