import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const compactOldBrand = ["wor", "de"].join("");
const splitOldBrand = ["word", "e"].join("_");
const oldBrandPattern = new RegExp(`${compactOldBrand}|${splitOldBrand}`, "i");

const files = execFileSync("git", ["ls-files"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim().split(/\r?\n/).filter(Boolean);

const matches = [];
for (const file of files) {
  const path = new URL(file.replaceAll("\\", "/"), repoRoot);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (oldBrandPattern.test(line)) {
      matches.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (matches.length > 0) {
  throw new Error(`Old brand references remain:\n${matches.join("\n")}`);
}
