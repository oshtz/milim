class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

Object.defineProperty(globalThis, "window", {
  value: { __TAURI_INTERNALS__: {} },
  configurable: true,
});

type InvokeCall = { command: string; args?: Record<string, unknown> };

const calls: InvokeCall[] = [];
const dbValues = new Map<string, string>();
let releaseSessionGet: (() => void) | undefined;
const sessionGetGate = new Promise<void>((resolve) => {
  releaseSessionGet = resolve;
});

const persistedSessions = JSON.stringify({
  state: {
    sessions: [
      {
        id: "persisted-session",
        title: "Persisted chat",
        messages: [
          { role: "user", content: "keep me" },
          {
            role: "assistant",
            content: "restored answer",
            streamParts: [
              {
                kind: "event",
                eventType: "tool",
                label: "Used tool",
                status: "done",
              },
            ],
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "title-only-session",
        title: "Recovered title only",
        createdAt: 2,
        updatedAt: 2,
      },
    ],
    projects: [
      {
        id: "project:C:\\keep",
        name: "Keep",
        folder: "C:\\keep",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    activeId: "persisted-session",
    archiveRetentionDays: 30,
    sidebar: {
      sectionOrder: ["chats", "project:C:\\keep"],
      projectFolders: ["C:\\keep"],
    },
  },
  version: 0,
});

dbValues.set("milim.sessions", persistedSessions);

Object.defineProperty(globalThis, "__MILIM_TEST_INVOKE__", {
  value: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "user_state_import_legacy") return null;
    if (command === "user_sessions_get") {
      await sessionGetGate;
      return dbValues.get("milim.sessions") ?? null;
    }
    if (command === "user_sessions_set") {
      dbValues.set("milim.sessions", String(args?.value));
      return null;
    }
    if (command === "user_state_get") {
      if (args?.key === "milim.sessions") await sessionGetGate;
      return dbValues.get(String(args?.key)) ?? null;
    }
    if (command === "user_state_set") {
      dbValues.set(String(args?.key), String(args?.value));
      return null;
    }
    if (command === "user_state_delete") {
      return dbValues.delete(String(args?.key));
    }
    throw new Error(`Unexpected command: ${command}`);
  },
  configurable: true,
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const { purgeExpiredArchivesAfterHydration, useSessions } =
  await import("../src/sessions/store.js");
const { flushDeferredUserStateWrites } =
  await import("../src/persistence/userStateStorage.js");

purgeExpiredArchivesAfterHydration();
await new Promise((resolve) => setTimeout(resolve, 0));

assert(
  !calls.some(
    (call) =>
      call.command === "user_state_set" && call.args?.key === "milim.sessions",
  ),
  "startup archive cleanup should not write sessions before hydration",
);

releaseSessionGet?.();
await new Promise((resolve) => setTimeout(resolve, 0));
if (!useSessions.persist.hasHydrated()) {
  await new Promise<void>((resolve) => {
    useSessions.persist.onFinishHydration(() => resolve());
  });
}
await flushDeferredUserStateWrites("milim.sessions");

const stored = JSON.parse(dbValues.get("milim.sessions") ?? "{}");
assert(
  stored.state.sessions[0]?.id === "persisted-session",
  "startup archive cleanup should preserve hydrated sessions",
);
assert(
  stored.state.sessions[1]?.id === "title-only-session",
  "hydration should keep recovered title-only sessions",
);
assert(
  Array.isArray(stored.state.sessions[1]?.messages),
  "title-only sessions should hydrate with an empty messages array",
);
assert(
  stored.state.projects[0]?.folder === "C:\\keep",
  "startup archive cleanup should preserve hydrated projects",
);
assert(
  stored.state.sessions[0]?.messages[0]?.content === "keep me",
  "startup archive cleanup should preserve messages",
);
const hydratedAssistant = useSessions.getState().sessions[0]?.messages[1];
assert(
  hydratedAssistant?.streamParts?.some(
    (part) => part.kind === "text" && part.content === "restored answer",
  ),
  "hydration should regenerate stripped text stream parts from assistant content",
);

export {};
