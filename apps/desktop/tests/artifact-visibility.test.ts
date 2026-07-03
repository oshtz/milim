import type { ChatArtifact, ChatMessage } from "../src/api.js";
import { hiddenArtifactIdsForMessage } from "../src/lib/artifactVisibility.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function artifact(id: string, filename: string, content: string, language: string, mime: string): ChatArtifact {
  return { id, kind: "code", title: filename, filename, content, language, mime, size: content.length };
}

const html = artifact("html", "index.html", "<main>Card</main>", "html", "text/html");
const css = artifact("css", "styles.css", ".card { color: red; }", "css", "text/css");
const csv = artifact("csv", "data.csv", "name,value\nA,1\nB,2", "csv", "text/csv");
const external = artifact("external", "extra.css", ".unused {}", "css", "text/css");

const message: ChatMessage = {
  role: "assistant",
  content: [
    "```html file=index.html",
    html.content,
    "```",
    "```css file=styles.css",
    css.content,
    "```",
    "```csv file=data.csv",
    csv.content,
    "```",
  ].join("\n"),
  artifacts: [html, css, csv, external],
};

const folderHidden = hiddenArtifactIdsForMessage(message, false);
assert(folderHidden, "folder mode should hide duplicated previewable artifacts");
equal(folderHidden.has("html"), true, "folder mode should hide inline html preview cards");
equal(folderHidden.has("css"), false, "folder mode should keep non-previewable css artifact controls");
equal(folderHidden.has("csv"), false, "folder mode should keep non-previewable csv artifact controls");

const noFolderHidden = hiddenArtifactIdsForMessage(message, true);
assert(noFolderHidden, "no-folder mode should hide inline artifact controls");
equal(noFolderHidden.has("html"), true, "no-folder mode should hide inline html artifact controls");
equal(noFolderHidden.has("css"), true, "no-folder mode should hide inline css artifact controls");
equal(noFolderHidden.has("csv"), true, "no-folder mode should hide inline csv artifact controls");
equal(noFolderHidden.has("external"), false, "artifacts not present in markdown should stay visible");

equal(hiddenArtifactIdsForMessage({ role: "assistant", content: "", artifacts: [html] }, true), undefined, "empty messages should not hide artifacts");
