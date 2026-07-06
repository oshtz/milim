import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useAgents } from "./agents/store";
import { deleteThreadTree, listModelsDetailed } from "./api";
import { AutoUpdater } from "./components/AutoUpdater";
import { ChatView } from "./components/ChatView";
import { ContextMenuProvider, useContextMenu } from "./components/ContextMenu";
import { Gear, Pencil, Plus, Sidebar as SidebarIcon } from "./components/icons";
import { ResizeHandles } from "./components/ResizeHandles";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import {
  shouldCheckOnboardingModels,
  shouldShowOnboarding,
  useOnboarding,
} from "./onboarding/store";
import {
  importLegacyLocalStorageOnce,
  installUserStateFlushHandlers,
} from "./persistence/userStateStorage.js";
import {
  purgeExpiredArchivesAfterHydration,
  useSessions,
} from "./sessions/store";
import { hydrateThemeFromUserState, useTheme } from "./theme/store";
import { featureVisibleInMode } from "./ui/features";
import { uiSizeShortcutDelta } from "./ui/shortcuts";
import { UI_SIZE_STEP, useUiPreferences } from "./ui/store";

const ThemePicker = lazy(() =>
  import("./components/ThemePicker").then((mod) => ({
    default: mod.ThemePicker,
  })),
);
const AgentsManager = lazy(() =>
  import("./components/AgentsManager").then((mod) => ({
    default: mod.AgentsManager,
  })),
);
const SkillsManager = lazy(() =>
  import("./components/SkillsManager").then((mod) => ({
    default: mod.SkillsManager,
  })),
);
const SchedulesManager = lazy(() =>
  import("./components/SchedulesManager").then((mod) => ({
    default: mod.SchedulesManager,
  })),
);
const OnboardingFlow = lazy(() =>
  import("./components/OnboardingFlow").then((mod) => ({
    default: mod.OnboardingFlow,
  })),
);

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function OnboardingGate() {
  const status = useOnboarding((s) => s.status);
  const developerShowOnboarding = useOnboarding(
    (s) => s.developerShowOnboarding,
  );
  const dismissedAt = useOnboarding((s) => s.dismissedAt);
  const shouldCheckModels = shouldCheckOnboardingModels(
    status,
    developerShowOnboarding,
  );
  const [hydrated, setHydrated] = useState(useOnboarding.persist.hasHydrated());
  const [modelsReady, setModelsReady] = useState(false);
  const [modelsChecked, setModelsChecked] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    if (useOnboarding.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return useOnboarding.persist.onFinishHydration(() => setHydrated(true));
  }, [hydrated]);

  const refreshModelReadiness = useCallback(async () => {
    try {
      const models = await listModelsDetailed();
      setModelsReady(models.length > 0);
    } catch {
      setModelsReady(false);
    } finally {
      setModelsChecked(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !shouldCheckModels) return;
    void refreshModelReadiness();
  }, [hydrated, refreshModelReadiness, shouldCheckModels]);

  if (!hydrated || (shouldCheckModels && !modelsChecked))
    return (
      <div
        className="onboarding-preflight"
        data-testid="onboarding-preflight"
      />
    );
  if (
    !shouldShowOnboarding(
      status,
      modelsReady,
      developerShowOnboarding,
      dismissedAt,
    )
  )
    return null;
  return <OnboardingFlow onModelsChanged={refreshModelReadiness} />;
}

export function App() {
  return (
    <ContextMenuProvider>
      <AppContent />
    </ContextMenuProvider>
  );
}

function AppContent() {
  // Subscribing here ensures the theme store initializes (and applies CSS vars)
  // before first paint.
  useTheme((s) => s.themeId);
  const { openContextMenu } = useContextMenu();
  const refreshAgents = useAgents((s) => s.refresh);
  const sessionIds = useSessions((s) =>
    s.sessions.map((session) => session.id).join("\0"),
  );
  const lastSessionIdsRef = useRef<Set<string> | null>(null);
  const [sessionsHydrated, setSessionsHydrated] = useState(() =>
    useSessions.persist.hasHydrated(),
  );
  useEffect(() => {
    installUserStateFlushHandlers();
    return purgeExpiredArchivesAfterHydration();
  }, []);
  useEffect(() => {
    if (sessionsHydrated) return;
    return useSessions.persist.onFinishHydration(() =>
      setSessionsHydrated(true),
    );
  }, [sessionsHydrated]);
  useEffect(() => {
    const ids = new Set(sessionIds ? sessionIds.split("\0") : []);
    if (!sessionsHydrated) return;
    const previous = lastSessionIdsRef.current;
    lastSessionIdsRef.current = ids;
    if (!previous) return;
    previous.forEach((id) => {
      if (!ids.has(id)) void deleteThreadTree(id).catch(() => {});
    });
  }, [sessionIds, sessionsHydrated]);
  useEffect(() => {
    refreshAgents();
  }, [refreshAgents]);
  useEffect(() => {
    void importLegacyLocalStorageOnce()
      .then(hydrateThemeFromUserState)
      .catch((e) => console.warn("Failed to hydrate user state:", e));
  }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsRevision, setSkillsRevision] = useState(0);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const [gitPanelRequest, setGitPanelRequest] = useState(0);
  const sidebarOpen = useUiPreferences((s) => s.sidebarOpen);
  const toggleSidebar = useUiPreferences((s) => s.toggleSidebar);
  const uiSize = useUiPreferences((s) => s.uiSize);
  const setUiSize = useUiPreferences((s) => s.setUiSize);
  const interfaceMode = useUiPreferences((s) => s.interfaceMode);
  const chatLayoutStyle = useUiPreferences((s) => s.chatLayoutStyle);
  const messageWidth = useUiPreferences((s) => s.messageWidth);
  const avatarStyle = useUiPreferences((s) => s.avatarStyle);
  const codeBlockTheme = useUiPreferences((s) => s.codeBlockTheme);
  const backgroundFit = useUiPreferences((s) => s.backgroundFit);
  const backgroundTreatment = useUiPreferences((s) => s.backgroundTreatment);
  const showSchedules = featureVisibleInMode("schedules", interfaceMode);
  const appClassName = [
    "app",
    `chat-layout-${chatLayoutStyle}`,
    `message-width-${messageWidth}`,
    `avatar-style-${avatarStyle}`,
    `code-theme-${codeBlockTheme}`,
    `bg-fit-${backgroundFit}`,
    `bg-treatment-${backgroundTreatment}`,
  ].join(" ");

  function focusComposer() {
    document
      .querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')
      ?.focus();
  }

  function openAppContextMenu(event: MouseEvent<HTMLDivElement>) {
    openContextMenu(
      event,
      [
        {
          id: "new-chat",
          label: "New chat",
          icon: <Plus size={13} />,
          action: () => {
            const { activeId, getSettings, newChat } = useSessions.getState();
            newChat(getSettings(activeId));
            focusComposer();
          },
        },
        {
          id: "focus-composer",
          label: "Focus composer",
          icon: <Pencil size={13} />,
          action: focusComposer,
        },
        {
          id: "toggle-sidebar",
          label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
          icon: <SidebarIcon size={13} />,
          action: toggleSidebar,
        },
        {
          id: "settings",
          label: "Settings",
          icon: <Gear size={13} />,
          separatorBefore: true,
          action: () => setSettingsOpen(true),
        },
      ],
      "App",
    );
  }

  useEffect(() => {
    if (!showSchedules) setSchedulesOpen(false);
  }, [showSchedules]);

  useEffect(() => {
    if (!inTauri) return;
    try {
      void getCurrentWebview()
        .setZoom(uiSize / 100)
        .catch(() => {});
    } catch {
      /* not in tauri */
    }
  }, [uiSize]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const delta = uiSizeShortcutDelta(event);
      if (!delta) return;
      event.preventDefault();
      setUiSize(useUiPreferences.getState().uiSize + delta * UI_SIZE_STEP);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setUiSize]);

  return (
    <div className={appClassName} onContextMenu={openAppContextMenu}>
      <div className="bg-layer" />
      <div className="main">
        <Sidebar
          open={sidebarOpen}
          onToggle={toggleSidebar}
          onOpenSettings={() => setSettingsOpen(true)}
          onManageSkills={() => setSkillsOpen(true)}
          onManageSchedules={() => setSchedulesOpen(true)}
          onGitAction={(text) => setComposerDraft({ id: Date.now(), text })}
          onOpenGitPanel={() => setGitPanelRequest((value) => value + 1)}
        />
        <div className="content">
          <TopBar />
          <ChatView
            onManageAgents={() => setAgentsOpen(true)}
            onOpenSchedules={() => setSchedulesOpen(true)}
            composerDraft={composerDraft}
            gitPanelRequest={gitPanelRequest}
            skillsRevision={skillsRevision}
            onComposerDraftConsumed={(id) =>
              setComposerDraft((current) =>
                current?.id === id ? null : current,
              )
            }
          />
        </div>
      </div>
      <Suspense fallback={null}>
        <OnboardingGate />
        {settingsOpen && <ThemePicker onClose={() => setSettingsOpen(false)} />}
        {agentsOpen && <AgentsManager onClose={() => setAgentsOpen(false)} />}
        {skillsOpen && (
          <SkillsManager
            onClose={() => {
              setSkillsOpen(false);
              setSkillsRevision((value) => value + 1);
            }}
          />
        )}
        {schedulesOpen && showSchedules && (
          <SchedulesManager onClose={() => setSchedulesOpen(false)} />
        )}
      </Suspense>
      <AutoUpdater />
      <ResizeHandles />
    </div>
  );
}
