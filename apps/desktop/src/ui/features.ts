import type { InterfaceMode } from "./store";

export type FeatureId =
  | "agents"
  | "computerUse"
  | "media"
  | "memoryManager"
  | "mcp"
  | "schedules"
  | "sandbox"
  | "voiceAdvanced"
  | "workspace";

const WORKBENCH_ONLY_FEATURES = new Set<FeatureId>([
  "agents",
  "computerUse",
  "media",
  "memoryManager",
  "mcp",
  "schedules",
  "sandbox",
  "voiceAdvanced",
  "workspace",
]);

export function featureVisibleInMode(feature: FeatureId, mode: InterfaceMode): boolean {
  return !WORKBENCH_ONLY_FEATURES.has(feature) || mode === "workbench";
}
