import type { SkillInfo, ToolInfo } from "../src/api.js";
import { composerTokenParts, composerTokensForText } from "../src/lib/composerTokens.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function skill(name: string, enabled = true): SkillInfo {
  return {
    id: `skill-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    description: "",
    instructions: "",
    enabled,
    source_kind: "builtin",
  };
}

function tool(name: string): ToolInfo {
  return { name, description: "", effect: "unknown" };
}

const skills = [
  skill("Code"),
  skill("Code Review"),
  skill("Design-Polish"),
  skill("Disabled Skill", false),
];
const tools = [tool("github__search"), tool("filesystem__read_file")];

const tagged = composerTokensForText("Please run @Code Review and /Design-Polish.", { skills, tools });
equal(tagged.length, 2, "skill tags should be detected");
equal(tagged[0]?.kind, "skill", "mention token kind");
equal(tagged[0]?.label, "Code Review", "longest skill name wins");
equal(tagged[0]?.start, "Please run ".length, "mention token start");
equal(tagged[1]?.label, "Design-Polish", "slash skill with hyphen");

const ignored = composerTokensForText("@Disabled Skill @Unknown Skill", { skills, tools });
equal(ignored.length, 0, "disabled and unknown skill tags should be ignored");

const mcp = composerTokensForText("Use /github__search then /missing__tool", { skills, tools });
equal(mcp.length, 1, "known MCP tool should be detected");
equal(mcp[0]?.kind, "mcp", "MCP token kind");
equal(mcp[0]?.value, "github__search", "MCP token value");

const files = composerTokensForText("Open @src/App.tsx and @\"docs/My File.md\"", { skills, tools });
equal(files.length, 2, "workspace file tags should be detected");
equal(files[0]?.kind, "file", "unquoted file token kind");
equal(files[0]?.value, "src/App.tsx", "unquoted file token value");
equal(files[1]?.value, "docs/My File.md", "quoted file token value");

const links = composerTokensForText("See https://milim.ai/docs.", { skills, tools });
equal(links.length, 1, "bare URL should be detected");
equal(links[0]?.kind, "link", "link token kind");
equal(links[0]?.value, "https://milim.ai/docs", "trailing punctuation should stay outside URL token");

const overlap = composerTokensForText("Open https://example.test/github__search and @Code Review", { skills, tools });
equal(overlap.length, 2, "link and later skill should both be detected");
equal(overlap[0]?.kind, "link", "URL should not be split by slash-like text");

const prompt = "Inspect @Code Review with /github__search at https://milim.ai";
const tokens = composerTokensForText(prompt, { skills, tools });
const parts = composerTokenParts(prompt, tokens);
assert(parts.some((part) => part.kind === "token" && part.token.kind === "mcp"), "highlight parts should include token spans");
equal(parts.map((part) => part.text).join(""), prompt, "highlight parts should preserve textarea value exactly");
