export type DiffRowKind = "file" | "meta" | "hunk" | "add" | "delete" | "context" | "stat" | "blank";

export type DiffRow = {
  kind: DiffRowKind;
  oldNo: string;
  newNo: string;
  marker: string;
  text: string;
};

export type DiffSection = {
  id: string;
  path: string;
  start: number;
  end: number;
  additions: number;
  deletions: number;
  lineCount: number;
};

export type DiffStats = {
  files: number;
  additions: number;
  deletions: number;
};

function cleanGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function parseHunkStart(line: string): { oldNo: number; newNo: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldNo: Number(match[1]), newNo: Number(match[2]) };
}

function diffFileLabel(line: string): string {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  return match ? cleanGitPath(match[2]) : line;
}

function contentLineText(line: string): string {
  return line.length > 0 ? line.slice(1) || " " : " ";
}

export function diffRows(text: string): DiffRow[] {
  let oldNo: number | null = null;
  let newNo: number | null = null;
  let inPatch = false;

  return text.split(/\r?\n/).map((line): DiffRow => {
    if (line.startsWith("diff --git ")) {
      inPatch = true;
      oldNo = null;
      newNo = null;
      return { kind: "file", oldNo: "", newNo: "", marker: "", text: diffFileLabel(line) };
    }

    if (!inPatch) {
      return { kind: line.trim() ? "stat" : "blank", oldNo: "", newNo: "", marker: "", text: line || " " };
    }

    if (line.startsWith("@@")) {
      const hunk = parseHunkStart(line);
      if (hunk) {
        oldNo = hunk.oldNo;
        newNo = hunk.newNo;
      }
      return { kind: "hunk", oldNo: "", newNo: "", marker: "@@", text: line };
    }

    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("\\ No newline")
    ) {
      return { kind: "meta", oldNo: "", newNo: "", marker: "", text: line || " " };
    }

    if (line.startsWith("+")) {
      const row = { kind: "add" as const, oldNo: "", newNo: newNo == null ? "" : String(newNo), marker: "+", text: contentLineText(line) };
      if (newNo != null) newNo += 1;
      return row;
    }

    if (line.startsWith("-")) {
      const row = { kind: "delete" as const, oldNo: oldNo == null ? "" : String(oldNo), newNo: "", marker: "-", text: contentLineText(line) };
      if (oldNo != null) oldNo += 1;
      return row;
    }

    const row = {
      kind: "context" as const,
      oldNo: oldNo == null ? "" : String(oldNo),
      newNo: newNo == null ? "" : String(newNo),
      marker: " ",
      text: contentLineText(line),
    };
    if (oldNo != null) oldNo += 1;
    if (newNo != null) newNo += 1;
    return row;
  });
}

export function diffSections(rows: DiffRow[]): DiffSection[] {
  const sections: DiffSection[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind !== "file") continue;
    const end = rows.findIndex((next, nextIndex) => nextIndex > index && next.kind === "file");
    const sectionRows = rows.slice(index, end === -1 ? rows.length : end);
    const additions = sectionRows.filter((item) => item.kind === "add").length;
    const deletions = sectionRows.filter((item) => item.kind === "delete").length;
    sections.push({
      id: `${sections.length}:${row.text}`,
      path: row.text,
      start: index,
      end: end === -1 ? rows.length : end,
      additions,
      deletions,
      lineCount: sectionRows.length,
    });
  }
  return sections;
}

export function diffStats(rows: DiffRow[]): DiffStats {
  return diffSections(rows).reduce(
    (stats, section) => ({
      files: stats.files + 1,
      additions: stats.additions + section.additions,
      deletions: stats.deletions + section.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export function shouldCollapseDiffSection(section: DiffSection): boolean {
  return section.lineCount > 320 || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock)$/i.test(section.path);
}
