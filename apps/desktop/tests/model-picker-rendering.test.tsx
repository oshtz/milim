import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { ModelInfo, ProviderInfo } from "../src/api.js";

type ModelPickerProps = {
  models: ModelInfo[];
  model: string;
  providers?: ProviderInfo[];
  toolIntent?: boolean;
  planMode?: boolean;
  onModel: (id: string) => void;
  onManageProviders: () => void;
  onManageMcp: () => void;
  onManageMemory: () => void;
  onClose: () => void;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const models: ModelInfo[] = [
  {
    id: "gpt-5-render",
    owned_by: "OpenAI",
    provider_id: "openai-render",
    context_length: 128000,
    capabilities: { imageInput: true, toolUse: true },
    reasoning: {
      supported_efforts: ["auto", "low", "medium", "high"],
      default_effort: "medium",
    },
  },
  {
    id: "black-forest-labs/flux-render",
    owned_by: "Replicate media",
    provider_id: "replicate-render",
    capabilities: { imageOutput: true },
  },
];

const providers: ProviderInfo[] = [
  {
    id: "openai-render",
    name: "OpenAI",
    kind: "openai_compatible",
    base_url: "https://api.openai.com/v1",
    enabled: true,
    has_key: true,
    models: ["gpt-5-render"],
  },
  {
    id: "replicate-render",
    name: "Replicate",
    kind: "replicate",
    base_url: "https://api.replicate.com",
    enabled: true,
    has_key: true,
    models: ["black-forest-labs/flux-render"],
  },
];

const server = await createServer({
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { ModelPicker } = (await server.ssrLoadModule(
    "/src/components/ModelPicker.tsx",
  )) as {
    ModelPicker: ComponentType<ModelPickerProps>;
  };
  const markup = renderToStaticMarkup(
    createElement(ModelPicker, {
      models,
      model: "gpt-5-render",
      providers,
      toolIntent: true,
      onModel: () => {},
      onManageProviders: () => {},
      onManageMcp: () => {},
      onManageMemory: () => {},
      onClose: () => {},
    }),
  );

  assert(markup.includes("OpenAI"), "Picker should render provider names");
  assert(markup.includes("Milim tools"), "Picker should keep the active dev runtime lane in accessible metadata");
  assert(markup.includes("Ready"), "Picker should keep setup status in accessible metadata");
  assert(!markup.includes("mp-meta"), "Picker rows should stay visually compact");
  assert(!markup.includes("128k ctx"), "Picker rows should not render context limits inline");
  assert(markup.includes("Reasoning effort for gpt-5-render: Auto"), "Picker should render reasoning effort state");
  assert(markup.includes('aria-pressed="false"'), "Favorite state should render on the star button");
  assert(markup.includes('title="Vision"'), "Vision capability badge should render");
  assert(markup.includes('title="Tool use"'), "Tool capability badge should render");
  assert(markup.includes("Replicate"), "Picker should render media providers");
  assert(markup.includes("Media"), "Picker should render media lane labels");
} finally {
  await server.close();
}

export {};
