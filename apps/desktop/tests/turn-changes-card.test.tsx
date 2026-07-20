import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type {
  WorkspaceCheckpoint,
  WorkspaceGitActionResult,
} from "../src/api.js";
import type { DiffSection, DiffStats } from "../src/lib/gitDiffRows.js";

type TurnChanges = {
  key: string;
  checkpoint: WorkspaceCheckpoint;
  result: WorkspaceGitActionResult;
  sections: DiffSection[];
  stats: DiffStats;
};

type TurnChangesCardProps = {
  sections: DiffSection[];
  stats: DiffStats;
  onUndo: () => void;
  onReview: () => void;
};

const checkpoint: WorkspaceCheckpoint = {
  ref: "refs/milim/checkpoints/turn-1",
  createdAt: 1,
  folder: "C:\\work",
};

function result(stdout: string, ok = true): WorkspaceGitActionResult {
  return {
    ok,
    action: "diff",
    command: "git diff",
    stdout,
    stderr: "",
    exit_code: ok ? 0 : 1,
    message: ok ? "Diff ready." : "Diff failed.",
    truncated: false,
  };
}

const patch = Array.from({ length: 5 }, (_, index) => {
  const path = `src/file-${index + 1}.ts`;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\n");
}).join("\n");

const server = await createServer({
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { TurnChangesCard, turnChangesFromDiff } = await server.ssrLoadModule(
    "/src/components/TurnChangesCard.tsx",
  ) as {
    TurnChangesCard: ComponentType<TurnChangesCardProps>;
    turnChangesFromDiff: (
      key: string,
      checkpoint: WorkspaceCheckpoint,
      result: WorkspaceGitActionResult,
    ) => TurnChanges | null;
  };
  const changes = turnChangesFromDiff("turn-1", checkpoint, result(patch));
  assert(changes);
  assert.deepEqual(changes.stats, { files: 5, additions: 5, deletions: 5 });
  assert.equal(changes.sections[0].path, "src/file-1.ts");
  assert.equal(turnChangesFromDiff("empty", checkpoint, result("")), null);
  assert.equal(turnChangesFromDiff("error", checkpoint, result("", false)), null);

  const markup = renderToStaticMarkup(
    createElement(TurnChangesCard, {
      sections: changes.sections,
      stats: changes.stats,
      onUndo: () => {},
      onReview: () => {},
    }),
  );
  assert.match(markup, /aria-label="Turn changes"/);
  assert.match(markup, />Changed 5 files</);
  assert.match(markup, />\+5</);
  assert.match(markup, />-5</);
  assert.match(markup, />Undo</);
  assert.match(markup, />Review changes</);
  assert.match(markup, /src\/file-1\.ts/);
  assert.match(markup, /src\/file-3\.ts/);
  assert.doesNotMatch(markup, /src\/file-4\.ts/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, />Show 2 more</);

  const single = { ...changes, sections: changes.sections.slice(0, 1), stats: { files: 1, additions: 1, deletions: 1 } };
  const singleMarkup = renderToStaticMarkup(
    createElement(TurnChangesCard, {
      sections: single.sections,
      stats: single.stats,
      onUndo: () => {},
      onReview: () => {},
    }),
  );
  assert.match(singleMarkup, />Changed 1 file</);
  assert.doesNotMatch(singleMarkup, /Show .* more/);
} finally {
  await server.close();
}
