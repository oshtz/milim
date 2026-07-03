import type { ChatMessage, SkillInfo } from "../api";

const MAX_SKILL_CHARS = 12_000;

export function skillInstructionMessage(skills: SkillInfo[]): ChatMessage | null {
  const enabled = skills.filter((s) => s.enabled);
  if (!enabled.length) return null;
  let body = enabled
    .map((s, i) => {
      const desc = s.description.trim();
      return [
        `## ${i + 1}. ${s.name}`,
        desc ? `Description: ${desc}` : "",
        s.instructions.trim(),
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
  if (body.length > MAX_SKILL_CHARS) body = body.slice(0, MAX_SKILL_CHARS) + "\n\n[Skills truncated]";
  return {
    role: "system",
    content: `Use these installed skills when relevant. Follow their instructions only if they help with the user's current request.\n\n${body}`,
  };
}
