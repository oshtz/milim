import { createElement } from "react";
import { createAvatarRecipe, defineShatzAvatar } from "@oshtz/shatz-avatars";
import { agentAvatarSeed } from "../api";

defineShatzAvatar();

const AGENT_AVATAR_PALETTES = [
  { color: "#ff6b6b", secondaryColor: "#28b8b4", background: "#ffe3bf" },
  { color: "#7c5cff", secondaryColor: "#e84a9b", background: "#e9ddff" },
  { color: "#198754", secondaryColor: "#e0a800", background: "#d9f4df" },
  { color: "#0f62fe", secondaryColor: "#33b1ff", background: "#d8e8ff" },
  { color: "#9f1853", secondaryColor: "#fa4d56", background: "#ffd6e8" },
  { color: "#007d79", secondaryColor: "#42be65", background: "#d1f5f2" },
  { color: "#6929c4", secondaryColor: "#1192e8", background: "#e8daff" },
  { color: "#b28600", secondaryColor: "#ff832b", background: "#fff1c7" },
] as const;

export function AgentAvatar({
  id,
  name,
  avatar,
  className = "",
}: {
  id?: string;
  name?: string;
  avatar?: string;
  className?: string;
}) {
  const seed = agentAvatarSeed({ id, name, avatar });
  const recipe = createAvatarRecipe(seed);
  const palette = AGENT_AVATAR_PALETTES[Math.floor(recipe.shape[0] * AGENT_AVATAR_PALETTES.length)];
  return createElement("shatz-avatar", {
    "aria-hidden": "true",
    background: palette.background,
    class: `agent-badge ${className}`.trim(),
    color: palette.color,
    "data-avatar-seed": seed,
    "secondary-color": palette.secondaryColor,
    seed,
    shape: "circle",
    title: "",
  });
}
