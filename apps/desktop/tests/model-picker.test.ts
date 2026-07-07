import { deepEqual, equal } from "node:assert/strict";
import type { ModelInfo, ProviderInfo } from "../src/api";
import {
  mergeModelListsForPicker,
  modelPickerGroups,
  providerOwnsModel,
  qualifyDuplicateProviderModels,
  rawModelId,
} from "../src/lib/modelPicker.js";

const duplicated = qualifyDuplicateProviderModels([
  { id: "same-model", owned_by: "OpenAI", provider_id: "prov-a" },
  { id: "same-model", owned_by: "Groq", provider_id: "prov-b" },
  { id: "unique-model", owned_by: "OpenAI", provider_id: "prov-a" },
] satisfies ModelInfo[]);

equal(duplicated[0].id, "provider:prov-a:same-model");
equal(duplicated[0].display_id, "same-model");
equal(duplicated[1].id, "provider:prov-b:same-model");
equal(duplicated[2].id, "unique-model");

equal(
  mergeModelListsForPicker(duplicated, [
    {
      id: "same-model",
      owned_by: "Replicate media",
      capabilities: { imageOutput: true },
    },
  ]).length,
  4,
  "same model ids from different providers should remain separate",
);

deepEqual(
  modelPickerGroups(
    [
      { id: "a1", owned_by: "Large" },
      { id: "a2", owned_by: "Large" },
      { id: "b1", owned_by: "Small" },
    ],
    [],
    false,
    "",
  ).map(([provider]) => provider),
  ["Small", "Large"],
  "smaller provider sections should appear first",
);

const providers = [
  {
    id: "prov-a",
    name: "OpenAI",
    kind: "openai_compatible",
    base_url: "https://api.openai.com/v1",
    enabled: true,
    has_key: true,
    models: ["same-model"],
  },
  {
    id: "prov-b",
    name: "Groq",
    kind: "openai_compatible",
    base_url: "https://api.groq.com/openai/v1",
    enabled: true,
    has_key: true,
    models: ["same-model"],
  },
] satisfies ProviderInfo[];

equal(providerOwnsModel(providers[1], "provider:prov-b:same-model"), true);
equal(providerOwnsModel(providers[0], "provider:prov-b:same-model"), false);
equal(rawModelId("provider:prov-b:same-model"), "same-model");
