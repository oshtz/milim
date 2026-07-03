import { diffRows, diffSections, diffStats, shouldCollapseDiffSection } from "../src/lib/gitDiffRows.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const rows = diffRows([
  " note.txt | 2 +-",
  "",
  "diff --git a/note.txt b/note.txt",
  "index 1111111..2222222 100644",
  "--- a/note.txt",
  "+++ b/note.txt",
  "@@ -1,2 +1,2 @@",
  " same",
  "-old",
  "+new",
].join("\n"));

assert(rows[0].kind === "stat", "stat summary should be classified");
assert(rows[2].kind === "file" && rows[2].text === "note.txt", "file row should show the changed path");
assert(rows[6].kind === "hunk", "hunk header should be classified");

const deleted = rows.find((row) => row.kind === "delete");
const added = rows.find((row) => row.kind === "add");
assert(deleted?.oldNo === "2" && deleted.text === "old", "deleted row should keep old line number");
assert(added?.newNo === "2" && added.text === "new", "added row should keep new line number");

const sections = diffSections(rows);
assert(sections.length === 1 && sections[0].path === "note.txt", "section should be created from file row");
assert(sections[0].additions === 1 && sections[0].deletions === 1, "section should count changed rows");

const stats = diffStats(rows);
assert(stats.files === 1 && stats.additions === 1 && stats.deletions === 1, "stats should summarize sections");
assert(shouldCollapseDiffSection({ ...sections[0], path: "pnpm-lock.yaml" }), "lockfiles should default collapsed");

export {};
