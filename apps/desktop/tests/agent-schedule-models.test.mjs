import { equal } from "node:assert/strict";
import { readFileSync } from "node:fs";

const agents = readFileSync("src/components/AgentsManager.tsx", "utf8");
equal(agents.includes('testId="agent-model-select"'), false, "agents should not own a model picker");
equal(agents.includes('model: ""'), true, "saving an agent should clear its legacy model");
equal(
  agents.includes("isAgentDraftModel(currentThreadModel) ? currentThreadModel"),
  true,
  "agent drafting should use the current thread model",
);

const schedules = readFileSync("src/components/SchedulesManager.tsx", "utf8");
equal(schedules.includes('testId="schedule-model-select"'), true, "schedules should require an explicit model");
equal(schedules.includes("scheduleModel(schedule) || agents.find"), true, "legacy schedules should fall back to their agent model");
equal(schedules.includes("model: model.trim()"), true, "schedule saves should persist the selected model");
