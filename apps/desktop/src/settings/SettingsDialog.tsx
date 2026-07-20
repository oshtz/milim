import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  listModelsDetailed,
  openDiagnosticsFolder,
  type ModelInfo,
} from "../api";
import { isThreadNamingModel } from "../lib/threadTitles";
import {
  SETTINGS_SEARCH_ENTRIES,
  matchingSettingsEntries,
  type SettingSearchEntry,
  type SettingsSectionId,
} from "./search";
import {
  SettingsBlock,
  SettingsChoiceGroup,
  SettingsPanel,
} from "./SettingsPrimitives";
import {
  AppearanceAvatarChoices,
  AppearanceBackgroundImageChoices,
  AppearanceChatLayoutChoices,
  AppearanceCodeBlockThemeChoices,
  AppearanceMessageWidthChoices,
} from "./AppearancePreviewChoices";
import { useTheme } from "../theme/store";
import { themeContrastIssues } from "../theme/contrast";
import type { Theme } from "../theme/types";
import { useOnboarding } from "../onboarding/store";
import { DAY_MS, useSessions, type ArchiveRetentionDays, type Project, type Session } from "../sessions/store";
import { useUpdateStore, type UpdateStatus } from "../update/store";
import { UpdateProgress } from "../update/UpdateProgress";
import {
  APP_SHORTCUT_ACTIONS,
  APP_SHORTCUT_LABELS,
  shortcutConflict,
  shortcutFromKeyboardEvent,
  shortcutLabel,
  shortcutValidationIssue,
  type AppShortcutAction,
} from "../ui/shortcuts";
import {
  ATTENTION_SOUND_OPTIONS,
  DEFAULT_UI_SIZE,
  DEFAULT_PREVIEW_PANEL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  FINISHED_SOUND_OPTIONS,
  MAX_UI_SIZE,
  MIN_UI_SIZE,
  UI_SIZE_STEP,
  useUiPreferences,
  type AttentionSound,
  type ComposerDensity,
  type ComposerSendShortcut,
  type FinishedSound,
} from "../ui/store";
import { playInterfaceSound } from "../ui/sounds";
import { Archive, Check, Code, Download, FolderOpen, Gear, GitLogo, Pencil, PlusSquare, Refresh, Search, Sidebar, Smartphone, Sun, Trash, X } from "../components/icons";
import { MobileCompanionSettings } from "../components/MobileCompanionSettings";
import { SheetDialog } from "../components/SheetDialog";
import { ThemeEditor } from "../components/ThemeEditor";
import { Select, Slider, Toggle } from "../components/ui";

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  detail: string;
  icon: typeof Gear;
  search: string[];
};
type SettingsStatusTone = "ready" | "warn" | "muted";
type SettingsSectionActivation = { focusTab?: boolean; remember?: boolean };
type ShortcutRecordingTarget = AppShortcutAction;

const SOUND_LABELS: Record<AttentionSound | FinishedSound, string> = {
  ready: "Ready",
  success: "Success",
  chime: "Chime",
  bloom: "Bloom",
  error: "Error",
  tick: "Tick",
  droplet: "Droplet",
};

let lastSettingsSection: SettingsSectionId = "app";

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "app",
    label: "App",
    detail: "Window behavior and layout",
    icon: Sidebar,
    search: ["app", "general", "window", "layout", "ui size", "zoom", "scale", "100", "percent", "sidebar", "new chat", "bottom", "always on top", "pin", "account usage", "quota", "codex", "claude", "panel", "width", "reset"],
  },
  {
    id: "chat",
    label: "Chat",
    detail: "Composer behavior and thread naming",
    icon: Pencil,
    search: ["chat", "composer", "send", "enter", "ctrl enter", "cmd enter", "density", "auto title", "ai title", "thread name", "naming model"],
  },
  {
    id: "appearance",
    label: "Appearance",
    detail: "Themes and custom styles",
    icon: Sun,
    search: ["theme", "themes", "dark", "light", "custom", "color", "style", "visual", "chat layout", "bubbles", "width", "avatar", "code", "background", "sound", "audio", "feedback", "cuelume"],
  },
  {
    id: "history",
    label: "History",
    detail: "Archived chats and projects",
    icon: Archive,
    search: ["archive", "history", "archived", "restore", "delete", "retention", "7 days", "14 days", "30 days", "projects", "folders", "threads"],
  },
  {
    id: "mobile",
    label: "Mobile",
    detail: "Phone companion relay and pairing",
    icon: Smartphone,
    search: ["mobile", "phone", "companion", "relay", "pair", "qr", "tailscale", "android"],
  },
  {
    id: "system",
    label: "System",
    detail: "Keyboard shortcuts and app commands",
    icon: Gear,
    search: ["system", "keyboard", "shortcut", "hotkey", "command", "reset"],
  },
  {
    id: "about",
    label: "About",
    detail: "Version and GitHub release updates",
    icon: GitLogo,
    search: ["about", "version", "update", "updates", "release", "download", "restart"],
  },
  {
    id: "developer",
    label: "Developer",
    detail: "Developer-only setup and experimental controls",
    icon: Code,
    search: ["developer", "debug", "test", "onboarding", "first run", "reset", "flow", "experimental", "hashline", "patch"],
  },
];
function onboardingSetupLabel(value: string | null): string {
  if (value === "local_detect") return "Local detection";
  if (value === "hosted") return "Hosted provider";
  return "Not chosen";
}

function timestampLabel(value: number | undefined): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function archiveDeleteLabel(archivedAt: number | undefined, retentionDays: ArchiveRetentionDays): string {
  if (!archivedAt) return "Not scheduled";
  return new Date(archivedAt + retentionDays * DAY_MS).toLocaleDateString();
}

function folderLabel(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() || folder || "Project";
}

function updateStatusLabel(status: UpdateStatus): string {
  if (status === "checking") return "Checking";
  if (status === "up-to-date") return "Up to date";
  if (status === "available") return "Available";
  if (status === "downloading") return "Downloading";
  if (status === "ready") return "Ready";
  if (status === "installing") return "Installing";
  if (status === "disabled") return "Disabled";
  if (status === "error") return "Error";
  return "Not checked";
}

function updateStatusTone(status: UpdateStatus): SettingsStatusTone {
  if (status === "available" || status === "ready" || status === "error") return "warn";
  if (status === "disabled" || status === "idle") return "muted";
  return "ready";
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const themes = useTheme((s) => s.themes);
  const custom = useTheme((s) => s.custom);
  const themeId = useTheme((s) => s.themeId);
  const current = useTheme((s) => s.theme);
  const activeBackgroundImage = current.background.image?.trim() ? current.background.image : undefined;
  const setTheme = useTheme((s) => s.setTheme);
  const sidebarOpen = useUiPreferences((s) => s.sidebarOpen);
  const sidebarWidth = useUiPreferences((s) => s.sidebarWidth);
  const previewPanelWidth = useUiPreferences((s) => s.previewPanelWidth);
  const uiSize = useUiPreferences((s) => s.uiSize);
  const showAccountUsageInTitleBar = useUiPreferences((s) => s.showAccountUsageInTitleBar);
  const windowAlwaysOnTop = useUiPreferences((s) => s.windowAlwaysOnTop);
  const interfaceSounds = useUiPreferences((s) => s.interfaceSounds);
  const soundOnFinished = useUiPreferences((s) => s.soundOnFinished);
  const soundOnAttention = useUiPreferences((s) => s.soundOnAttention);
  const soundOnInteractions = useUiPreferences((s) => s.soundOnInteractions);
  const finishedSound = useUiPreferences((s) => s.finishedSound);
  const attentionSound = useUiPreferences((s) => s.attentionSound);
  const composerSendShortcut = useUiPreferences((s) => s.composerSendShortcut);
  const composerDensity = useUiPreferences((s) => s.composerDensity);
  const autoTitleChats = useUiPreferences((s) => s.autoTitleChats);
  const aiThreadNames = useUiPreferences((s) => s.aiThreadNames);
  const aiThreadNameModel = useUiPreferences((s) => s.aiThreadNameModel);
  const newChatButtonAtBottom = useUiPreferences((s) => s.newChatButtonAtBottom);
  const developerMode = useUiPreferences((s) => s.developerMode);
  const experimentalHashlinePatch = useUiPreferences((s) => s.experimentalHashlinePatch);
  const chatLayoutStyle = useUiPreferences((s) => s.chatLayoutStyle);
  const messageWidth = useUiPreferences((s) => s.messageWidth);
  const avatarStyle = useUiPreferences((s) => s.avatarStyle);
  const codeBlockTheme = useUiPreferences((s) => s.codeBlockTheme);
  const backgroundFit = useUiPreferences((s) => s.backgroundFit);
  const backgroundTreatment = useUiPreferences((s) => s.backgroundTreatment);
  const appShortcuts = useUiPreferences((s) => s.appShortcuts);
  const setSidebarOpen = useUiPreferences((s) => s.setSidebarOpen);
  const setUiSize = useUiPreferences((s) => s.setUiSize);
  const setShowAccountUsageInTitleBar = useUiPreferences((s) => s.setShowAccountUsageInTitleBar);
  const setWindowAlwaysOnTop = useUiPreferences((s) => s.setWindowAlwaysOnTop);
  const setInterfaceSounds = useUiPreferences((s) => s.setInterfaceSounds);
  const setSoundOnFinished = useUiPreferences((s) => s.setSoundOnFinished);
  const setSoundOnAttention = useUiPreferences((s) => s.setSoundOnAttention);
  const setSoundOnInteractions = useUiPreferences((s) => s.setSoundOnInteractions);
  const setFinishedSound = useUiPreferences((s) => s.setFinishedSound);
  const setAttentionSound = useUiPreferences((s) => s.setAttentionSound);
  const setComposerSendShortcut = useUiPreferences((s) => s.setComposerSendShortcut);
  const setComposerDensity = useUiPreferences((s) => s.setComposerDensity);
  const setAutoTitleChats = useUiPreferences((s) => s.setAutoTitleChats);
  const setAiThreadNames = useUiPreferences((s) => s.setAiThreadNames);
  const setAiThreadNameModel = useUiPreferences((s) => s.setAiThreadNameModel);
  const setNewChatButtonAtBottom = useUiPreferences((s) => s.setNewChatButtonAtBottom);
  const setDeveloperMode = useUiPreferences((s) => s.setDeveloperMode);
  const setExperimentalHashlinePatch = useUiPreferences((s) => s.setExperimentalHashlinePatch);
  const setChatLayoutStyle = useUiPreferences((s) => s.setChatLayoutStyle);
  const setMessageWidth = useUiPreferences((s) => s.setMessageWidth);
  const setAvatarStyle = useUiPreferences((s) => s.setAvatarStyle);
  const setCodeBlockTheme = useUiPreferences((s) => s.setCodeBlockTheme);
  const setBackgroundFit = useUiPreferences((s) => s.setBackgroundFit);
  const setBackgroundTreatment = useUiPreferences((s) => s.setBackgroundTreatment);
  const resetLayoutWidths = useUiPreferences((s) => s.resetLayoutWidths);
  const setAppShortcut = useUiPreferences((s) => s.setAppShortcut);
  const resetAppShortcuts = useUiPreferences((s) => s.resetAppShortcuts);
  const onboardingStatus = useOnboarding((s) => s.status);
  const onboardingSetupPath = useOnboarding((s) => s.selectedSetupPath);
  const onboardingDeveloperShow = useOnboarding((s) => s.developerShowOnboarding);
  const onboardingCompletedAt = useOnboarding((s) => s.completedAt);
  const onboardingDismissedAt = useOnboarding((s) => s.dismissedAt);
  const setDeveloperShowOnboarding = useOnboarding((s) => s.setDeveloperShowOnboarding);
  const completeOnboarding = useOnboarding((s) => s.complete);
  const resetOnboarding = useOnboarding((s) => s.reset);
  const updateCurrentVersion = useUpdateStore((s) => s.currentVersion);
  const updateStatus = useUpdateStore((s) => s.status);
  const updateInfo = useUpdateStore((s) => s.updateInfo);
  const updatePath = useUpdateStore((s) => s.updatePath);
  const updateProgress = useUpdateStore((s) => s.downloadProgress);
  const updateError = useUpdateStore((s) => s.error);
  const updateLastCheckedAt = useUpdateStore((s) => s.lastCheckedAt);
  const loadCurrentVersion = useUpdateStore((s) => s.loadCurrentVersion);
  const checkForAppUpdate = useUpdateStore((s) => s.checkNow);
  const downloadAppUpdate = useUpdateStore((s) => s.downloadNow);
  const installAppUpdate = useUpdateStore((s) => s.installNow);
  const sessions = useSessions((s) => s.sessions);
  const projects = useSessions((s) => s.projects);
  const archiveRetentionDays = useSessions((s) => s.archiveRetentionDays);
  const setArchiveRetentionDays = useSessions((s) => s.setArchiveRetentionDays);
  const restoreSession = useSessions((s) => s.restoreSession);
  const removeSession = useSessions((s) => s.remove);
  const restoreProject = useSessions((s) => s.restoreProject);
  const removeProject = useSessions((s) => s.removeProject);
  const purgeExpiredArchives = useSessions((s) => s.purgeExpiredArchives);

  const [editing, setEditing] = useState<{ base: Theme; isNew: boolean } | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(lastSettingsSection);
  const [settingsQuery, setSettingsQuery] = useState("");
  const [highlightedSettingId, setHighlightedSettingId] = useState<string | null>(null);
  const [confirmArchiveDelete, setConfirmArchiveDelete] = useState<string | null>(null);
  const [threadNameModels, setThreadNameModels] = useState<ModelInfo[]>([]);
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutRecordingTarget | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const archivedSessions = useMemo(
    () => sessions.filter((session) => session.archivedAt).slice().sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [sessions],
  );
  const archivedProjects = useMemo(
    () => projects.filter((project) => project.archivedAt).slice().sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [projects],
  );
  const archivedCount = archivedSessions.length + archivedProjects.length;
  const systemStatus =
    updateStatus === "available" || updateStatus === "ready" || updateStatus === "error"
      ? { label: updateStatusLabel(updateStatus), tone: updateStatusTone(updateStatus) }
      : developerMode
        ? { label: "Developer on", tone: "ready" as SettingsStatusTone }
        : { label: updateStatusLabel(updateStatus), tone: updateStatusTone(updateStatus) };
  const sectionStatus: Record<SettingsSectionId, { label: string; tone: SettingsStatusTone }> = {
    app: { label: "Ready", tone: "ready" },
    chat: { label: aiThreadNames ? "AI names" : "Manual names", tone: "ready" },
    appearance: { label: current.name, tone: "ready" },
    history: { label: archivedCount ? `${archivedCount} archived` : "Empty", tone: archivedCount ? "warn" : "muted" },
    mobile: { label: "Relay", tone: "muted" },
    system: { label: "Shortcuts", tone: "ready" },
    about: systemStatus,
    developer: { label: developerMode ? "On" : "Off", tone: developerMode ? "ready" : "muted" },
  };
  const visibleSettingsSections = SETTINGS_SECTIONS;
  const sectionStatusKey = `${windowAlwaysOnTop}\n${uiSize}\n${showAccountUsageInTitleBar}\n${composerSendShortcut}\n${Object.values(appShortcuts).join("\n")}\n${aiThreadNames}\n${aiThreadNameModel}\n${developerMode}\n${experimentalHashlinePatch}\n${onboardingStatus}\n${onboardingDeveloperShow}\n${systemStatus.label}\n${systemStatus.tone}\n${archivedCount}\n${archiveRetentionDays}\n${current.name}\n${updateStatus}\n${chatLayoutStyle}\n${messageWidth}\n${avatarStyle}\n${codeBlockTheme}\n${backgroundFit}\n${backgroundTreatment}`;
  const normalizedSettingsQuery = settingsQuery.trim().toLowerCase();
  const settingsSearchResults = useMemo(
    () => matchingSettingsEntries(settingsQuery),
    [settingsQuery],
  );
  const filteredSettingsSections = useMemo(() => {
    if (!normalizedSettingsQuery) return visibleSettingsSections;
    const resultSections = new Set(settingsSearchResults.map((entry) => entry.section));
    return visibleSettingsSections.filter((section) => {
      const status = sectionStatus[section.id];
      const settingText = SETTINGS_SEARCH_ENTRIES
        .filter((entry) => entry.section === section.id)
        .map((entry) => [entry.label, ...(entry.aliases ?? [])].join(" "))
        .join(" ");
      return resultSections.has(section.id) || [section.id, section.label, section.detail, status.label, settingText, ...section.search]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSettingsQuery);
    });
  }, [normalizedSettingsQuery, sectionStatusKey, settingsSearchResults, visibleSettingsSections]);
  useEffect(() => {
    if (filteredSettingsSections.length === 0) return;
    if (!filteredSettingsSections.some((section) => section.id === activeSection)) {
      activateSettingsSection(filteredSettingsSections[0].id, { focusTab: false, remember: false });
    }
  }, [activeSection, filteredSettingsSections]);

  useEffect(() => {
    void loadCurrentVersion();
  }, [loadCurrentVersion]);

  useEffect(() => {
    let cancelled = false;
    listModelsDetailed()
      .then((items) => {
        if (!cancelled) setThreadNameModels(items.filter(isThreadNamingModel));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!recordingShortcut) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => recordAppShortcut(recordingShortcut, event);
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [appShortcuts, recordingShortcut]);

  useEffect(() => {
    if (!confirmArchiveDelete) return;
    const timer = window.setTimeout(() => setConfirmArchiveDelete(null), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmArchiveDelete]);

  useEffect(() => {
    if (!highlightedSettingId) return;
    const timer = window.setTimeout(() => setHighlightedSettingId(null), 1600);
    return () => window.clearTimeout(timer);
  }, [highlightedSettingId]);

  if (editing) {
    return <ThemeEditor base={editing.base} isNew={editing.isNew} onClose={() => setEditing(null)} />;
  }

  const threadNameModelOptions = [
    { value: "", label: "Use chat model" },
    ...threadNameModels.map((item) => ({ value: item.id, label: item.id })),
  ];
  if (aiThreadNameModel && isThreadNamingModel(aiThreadNameModel) && !threadNameModelOptions.some((option) => option.value === aiThreadNameModel)) {
    threadNameModelOptions.push({ value: aiThreadNameModel, label: aiThreadNameModel });
  }

  const customIds = new Set(custom.map((c) => c.id));
  const updateBusy = updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "installing";
  const canCheckForUpdate = !updateBusy;
  const canDownloadUpdate = updateStatus === "available" && !!updateInfo;
  const canInstallUpdate = updateStatus === "ready" && !!updatePath;
  const latestVersionLabel = updateInfo ? `v${updateInfo.version}` : "Not checked";
  const currentVersionLabel = updateCurrentVersion ? `v${updateCurrentVersion}` : "Unknown";
  const archiveRetentionValue = String(archiveRetentionDays) as "7" | "14" | "30";
  const projectNameByFolder = new Map(projects.map((project) => [project.folder, project.name]));
  const activeSettingsSection = SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0];

  function setArchiveRetentionFromSettings(value: "7" | "14" | "30") {
    setArchiveRetentionDays(Number(value) as ArchiveRetentionDays);
    useSessions.getState().purgeExpiredArchives();
  }

  function archivedSessionProjectLabel(session: Session): string {
    const folder = session.settings?.folder?.trim() ?? "";
    return folder ? projectNameByFolder.get(folder) ?? folderLabel(folder) : "Chats";
  }

  function projectThreadCount(project: Project): number {
    return sessions.filter((session) => !session.parentId && session.settings?.folder?.trim() === project.folder).length;
  }

  function deleteArchivedSession(id: string) {
    const key = `session:${id}`;
    if (confirmArchiveDelete !== key) {
      setConfirmArchiveDelete(key);
      return;
    }
    removeSession(id);
    setConfirmArchiveDelete(null);
  }

  function deleteArchivedProject(id: string) {
    const key = `project:${id}`;
    if (confirmArchiveDelete !== key) {
      setConfirmArchiveDelete(key);
      return;
    }
    removeProject(id);
    setConfirmArchiveDelete(null);
  }

  function purgeExpiredArchivesFromSettings() {
    purgeExpiredArchives();
    setConfirmArchiveDelete(null);
  }

  async function checkUpdatesFromSettings() {
    await checkForAppUpdate();
  }

  async function downloadUpdateFromSettings() {
    await downloadAppUpdate();
  }

  async function installUpdateFromSettings() {
    await installAppUpdate();
  }

  async function openLogsFromSettings() {
    setDiagnosticsError(null);
    try {
      await openDiagnosticsFolder();
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : String(error));
    }
  }

  function recordAppShortcut(target: ShortcutRecordingTarget, event: globalThis.KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    const shortcut = shortcutFromKeyboardEvent(event);
    if (!shortcut) {
      setShortcutError("Use a modifier, Escape, or an F-key.");
      return;
    }
    const issue = shortcutValidationIssue(shortcut);
    if (issue) {
      setShortcutError(issue);
      return;
    }
    const conflict = shortcutConflict(appShortcuts, target, shortcut);
    if (conflict) {
      setShortcutError(`${shortcutLabel(shortcut)} is already used by ${APP_SHORTCUT_LABELS[conflict]}.`);
      return;
    }
    if (!setAppShortcut(target, shortcut)) {
      setShortcutError("Shortcut could not be saved.");
      return;
    }
    setRecordingShortcut(null);
    setShortcutError(null);
  }

  function startRecordingShortcut(target: ShortcutRecordingTarget) {
    setRecordingShortcut((current) => current === target ? null : target);
    setShortcutError(null);
  }

  function activateSettingsSection(sectionId: SettingsSectionId, options: SettingsSectionActivation = {}) {
    const { focusTab = false, remember = true } = options;
    setActiveSection(sectionId);
    if (remember) {
      lastSettingsSection = sectionId;
    }
    if (focusTab) {
      window.requestAnimationFrame(() => {
        document.getElementById(`settings-tab-${sectionId}`)?.focus({ preventScroll: true });
      });
    }
  }

  function openSettingSearchResult(entry: SettingSearchEntry) {
    activateSettingsSection(entry.section);
    setHighlightedSettingId(entry.id);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(`[data-setting-id="${entry.id}"]`);
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
        const focusable = target?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])");
        (focusable ?? target)?.focus({ preventScroll: true });
      });
    });
  }

  function selectSettingsSection(sectionId: SettingsSectionId, options: SettingsSectionActivation = {}) {
    activateSettingsSection(sectionId, options);
  }

  function onSettingsNavKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = filteredSettingsSections.findIndex((section) => section.id === activeSection);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % filteredSettingsSections.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + filteredSettingsSections.length) % filteredSettingsSections.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = filteredSettingsSections.length - 1;
    }

    if (nextIndex == null) return;
    event.preventDefault();
    selectSettingsSection(filteredSettingsSections[nextIndex].id, { focusTab: true });
  }

  const settingHighlightClass = (id: string) => highlightedSettingId === id ? " setting-highlight" : "";

  return (
    <SheetDialog title="Settings" className="sheet" testId="settings-dialog" onClose={onClose}>
        <div className="sheet-header">
          <h2>Settings</h2>
          <button
            className="icon-btn sheet-close"
            data-testid="close-settings"
            onClick={onClose}
            title="Close"
            aria-label="Close settings"
          >
            <X size={15} />
          </button>
        </div>
        <p className="sheet-sub">Configure app-level preferences that apply across chats.</p>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <div className="settings-nav-search">
              <Search size={14} aria-hidden="true" />
              <input
                data-testid="settings-search"
                type="search"
                value={settingsQuery}
                onChange={(event) => setSettingsQuery(event.currentTarget.value)}
                placeholder="Search settings"
                aria-label="Search settings"
              />
              {settingsQuery ? (
                <button
                  className="settings-nav-search-clear"
                  type="button"
                  onClick={() => setSettingsQuery("")}
                  title="Clear search"
                  aria-label="Clear settings search"
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
            <div className="settings-nav-list" role="tablist" aria-label="Settings sections">
              {filteredSettingsSections.map((section) => {
                const Icon = section.icon;
                const selected = activeSection === section.id;
                const status = sectionStatus[section.id];
                return (
                  <button
                    key={section.id}
                    id={`settings-tab-${section.id}`}
                    className={"settings-nav-item" + (selected ? " active" : "")}
                    type="button"
                    role="tab"
                    data-testid={`settings-section-${section.id}`}
                    aria-selected={selected}
                    aria-controls={`settings-panel-${section.id}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => selectSettingsSection(section.id)}
                    onKeyDown={onSettingsNavKeyDown}
                  >
                    <span className="settings-nav-icon" aria-hidden="true">
                      <Icon size={15} />
                    </span>
                    <span className="settings-nav-copy">
                      <span className="settings-nav-label">{section.label}</span>
                    </span>
                    {status.tone === "warn" ? (
                      <span
                        className="settings-nav-status warn"
                        aria-label={`${section.label}: ${status.label}`}
                        title={status.label}
                      >
                        {status.label}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {filteredSettingsSections.length === 0 ? (
                <div className="settings-nav-empty">No settings match.</div>
              ) : null}
            </div>
              {settingsSearchResults.length > 0 ? (
                <div className="settings-search-results" aria-label="Matching settings">
                  {settingsSearchResults.slice(0, 8).map((entry) => {
                    const section = SETTINGS_SECTIONS.find((item) => item.id === entry.section);
                    return (
                      <button
                        key={entry.id}
                        className="settings-search-result"
                        type="button"
                        onClick={() => openSettingSearchResult(entry)}
                      >
                        <span>{entry.label}</span>
                        <small>{section?.label ?? entry.section}</small>
                      </button>
                    );
                  })}
                </div>
              ) : null}
          </nav>

          <div className="settings-detail">
            <div className="settings-detail-head">
              <div>
                <h3>{activeSettingsSection.label}</h3>
                <p>{activeSettingsSection.detail}</p>
              </div>
              <div className="settings-section-actions">
                <span className={`settings-status-pill ${sectionStatus[activeSection].tone}`}>{sectionStatus[activeSection].label}</span>
              </div>
            </div>

            <div className="settings-content">
            {activeSection === "app" && (
        <section className="settings-section" id="settings-panel-app" role="tabpanel" aria-labelledby="settings-tab-app" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Window and layout" data-setting-id="app-window-layout" className={settingHighlightClass("app-window-layout").trim()}>
              <div className="setting-stack">
                <div className="setting-toggle-row">
                  <div>
                    <strong>Keep window on top</strong>
                    <span>Pin Milim above other windows and remember that choice.</span>
                  </div>
                  <Toggle
                    checked={windowAlwaysOnTop}
                    onChange={setWindowAlwaysOnTop}
                    testId="general-always-on-top-toggle"
                  />
                </div>
                <div className="setting-toggle-row">
                  <div>
                    <strong>Open sidebar</strong>
                    <span>Keep the chat list visible by default.</span>
                  </div>
                  <Toggle checked={sidebarOpen} onChange={setSidebarOpen} testId="general-sidebar-open-toggle" />
                </div>
                <div className="setting-field">
                  <div className="settings-action-row">
                    <div>
                      <strong>UI size</strong>
                      <span>Scale the whole app to {uiSize}%.</span>
                    </div>
                    <button className="btn-ghost" type="button" data-testid="general-reset-ui-size" disabled={uiSize === DEFAULT_UI_SIZE} onClick={() => setUiSize(DEFAULT_UI_SIZE)}>
                      <Refresh size={13} />
                      Reset
                    </button>
                  </div>
                  <Slider ariaLabel="UI size" min={MIN_UI_SIZE} max={MAX_UI_SIZE} step={UI_SIZE_STEP} value={uiSize} onChange={setUiSize} />
                </div>
                <div className="setting-toggle-row">
                  <div>
                    <strong>Show account usage in title bar</strong>
                    <span>Show compact quota details for the active Codex or Claude runtime.</span>
                  </div>
                  <Toggle checked={showAccountUsageInTitleBar} onChange={setShowAccountUsageInTitleBar} testId="general-titlebar-account-usage-toggle" />
                </div>
                <div className="setting-toggle-row">
                  <div>
                    <strong>New chat at bottom</strong>
                    <span>Anchor the new chat button above the sidebar footer.</span>
                  </div>
                  <Toggle checked={newChatButtonAtBottom} onChange={setNewChatButtonAtBottom} testId="general-new-chat-bottom-toggle" />
                </div>
                <div className="settings-action-row">
                  <div>
                    <strong>Panel widths</strong>
                    <span>
                      Sidebar {sidebarWidth}px / Preview {previewPanelWidth}px
                    </span>
                  </div>
                  <button className="btn-ghost" type="button" data-testid="general-reset-layout" onClick={resetLayoutWidths}>
                    Reset
                  </button>
                </div>
                <p className="sheet-hint">
                  Default reset: sidebar {DEFAULT_SIDEBAR_WIDTH}px and preview {DEFAULT_PREVIEW_PANEL_WIDTH}px.
                </p>
              </div>
            </SettingsBlock>
            </SettingsPanel>
        </section>
            )}

            {activeSection === "chat" && (
        <section className="settings-section" id="settings-panel-chat" role="tabpanel" aria-labelledby="settings-tab-chat" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Composer" data-setting-id="chat-composer" className={settingHighlightClass("chat-composer").trim()}>
              <div className="setting-stack">
                <div className="setting-field">
                  <span className="setting-mini-title">Send shortcut</span>
                  <SettingsChoiceGroup<ComposerSendShortcut>
                    value={composerSendShortcut}
                    onChange={setComposerSendShortcut}
                    testIdPrefix="chat-send-shortcut"
                    options={[
                      { value: "enter", label: "Enter", detail: "Enter sends. Shift+Enter adds a line." },
                      { value: "modEnter", label: "Ctrl / Cmd+Enter", detail: "Enter adds lines. Modifier sends." },
                    ]}
                  />
                </div>
                <div className="setting-field">
                  <span className="setting-mini-title">Composer density</span>
                  <SettingsChoiceGroup<ComposerDensity>
                    value={composerDensity}
                    onChange={setComposerDensity}
                    testIdPrefix="chat-composer-density"
                    options={[
                      { value: "comfortable", label: "Comfortable", detail: "More breathing room for normal drafting." },
                      { value: "compact", label: "Compact", detail: "Tighter composer for small screens." },
                    ]}
                  />
                </div>
              </div>
            </SettingsBlock>

            <SettingsBlock title="Threads" data-setting-id="chat-threads" className={settingHighlightClass("chat-threads").trim()}>
              <div className="setting-stack">
                <div className="setting-toggle-row">
                  <div>
                    <strong>Auto-title new chats</strong>
                    <span>Rename a new chat from the first user message.</span>
                  </div>
                  <Toggle checked={autoTitleChats} onChange={setAutoTitleChats} testId="chat-auto-title-toggle" />
                </div>
                <div className="setting-toggle-row">
                  <div>
                    <strong>AI thread names</strong>
                    <span>After the first reply, ask a model for a 2-5 word name.</span>
                  </div>
                  <Toggle checked={aiThreadNames} onChange={setAiThreadNames} testId="chat-ai-title-toggle" />
                </div>
                {aiThreadNames && (
                  <div className="setting-field">
                    <span className="setting-mini-title">Naming model</span>
                    <Select
                      value={aiThreadNameModel}
                      options={threadNameModelOptions}
                      onChange={setAiThreadNameModel}
                      placeholder="Use chat model"
                      testId="chat-ai-title-model"
                    />
                    <p className="sheet-hint">
                      {autoTitleChats ? "Leave empty to use compatible chat models. Choose a provider model for Codex, Claude, or media chats." : "Auto-title new chats is off."}
                    </p>
                  </div>
                )}
              </div>
            </SettingsBlock>
          </SettingsPanel>
        </section>
            )}

            {activeSection === "history" && (
        <section className="settings-section" id="settings-panel-history" role="tabpanel" aria-labelledby="settings-tab-history" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Retention" data-setting-id="history-retention" className={settingHighlightClass("history-retention").trim()}>
              <div className="setting-stack">
                <div className="setting-field">
                  <span className="setting-mini-title">Delete archived items after</span>
                  <SettingsChoiceGroup<"7" | "14" | "30">
                    value={archiveRetentionValue}
                    onChange={setArchiveRetentionFromSettings}
                    testIdPrefix="archive-retention"
                    options={[
                      { value: "7", label: "7 days", detail: "Short cleanup window." },
                      { value: "14", label: "14 days", detail: "Two-week recovery window." },
                      { value: "30", label: "30 days", detail: "Maximum recovery window." },
                    ]}
                  />
                </div>
                <div className="settings-action-row">
                  <div>
                    <strong>Expired items</strong>
                    <span>Archived chats and projects older than {archiveRetentionDays} days are removed.</span>
                  </div>
                  <button className="btn-ghost" type="button" onClick={purgeExpiredArchivesFromSettings}>
                    <Trash size={13} />
                    Purge now
                  </button>
                </div>
              </div>
            </SettingsBlock>

            <SettingsBlock title="Projects" data-setting-id="history-projects" className={settingHighlightClass("history-projects").trim()}>
              {archivedProjects.length === 0 ? (
                <p className="sheet-hint">No archived projects.</p>
              ) : (
                <div className="archive-list">
                  {archivedProjects.map((project) => {
                    const deleteKey = `project:${project.id}`;
                    return (
                      <div className="settings-action-row archive-row" key={project.id}>
                        <div>
                          <strong>{project.name}</strong>
                          <span>{project.folder}</span>
                          <span>{projectThreadCount(project)} chats · deletes {archiveDeleteLabel(project.archivedAt, archiveRetentionDays)}</span>
                        </div>
                        <div className="archive-row-actions">
                          <button
                            className="btn-ghost archive-action-button"
                            type="button"
                            title={`Restore ${project.name}`}
                            aria-label={`Restore ${project.name}`}
                            onClick={() => restoreProject(project.id)}
                          >
                            <Refresh size={13} />
                          </button>
                          <button
                            className={"btn-ghost danger archive-action-button" + (confirmArchiveDelete === deleteKey ? " confirm" : "")}
                            type="button"
                            title={confirmArchiveDelete === deleteKey ? `Confirm delete ${project.name}` : `Delete ${project.name}`}
                            aria-label={confirmArchiveDelete === deleteKey ? `Confirm delete ${project.name}` : `Delete ${project.name}`}
                            onClick={() => deleteArchivedProject(project.id)}
                          >
                            {confirmArchiveDelete === deleteKey ? "Confirm?" : <Trash size={13} />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SettingsBlock>

            <SettingsBlock title="Chats" data-setting-id="history-chats" className={settingHighlightClass("history-chats").trim()}>
              {archivedSessions.length === 0 ? (
                <p className="sheet-hint">No archived chats.</p>
              ) : (
                <div className="archive-list">
                  {archivedSessions.map((session) => {
                    const deleteKey = `session:${session.id}`;
                    return (
                      <div className="settings-action-row archive-row" key={session.id}>
                        <div>
                          <strong>{session.title}</strong>
                          <span>{archivedSessionProjectLabel(session)}</span>
                          <span>Archived {timestampLabel(session.archivedAt)} · deletes {archiveDeleteLabel(session.archivedAt, archiveRetentionDays)}</span>
                        </div>
                        <div className="archive-row-actions">
                          <button
                            className="btn-ghost archive-action-button"
                            type="button"
                            title={`Restore ${session.title}`}
                            aria-label={`Restore ${session.title}`}
                            onClick={() => restoreSession(session.id)}
                          >
                            <Refresh size={13} />
                          </button>
                          <button
                            className={"btn-ghost danger archive-action-button" + (confirmArchiveDelete === deleteKey ? " confirm" : "")}
                            type="button"
                            title={confirmArchiveDelete === deleteKey ? `Confirm delete ${session.title}` : `Delete ${session.title}`}
                            aria-label={confirmArchiveDelete === deleteKey ? `Confirm delete ${session.title}` : `Delete ${session.title}`}
                            onClick={() => deleteArchivedSession(session.id)}
                          >
                            {confirmArchiveDelete === deleteKey ? "Confirm?" : <Trash size={13} />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SettingsBlock>
          </SettingsPanel>
        </section>
            )}

            {activeSection === "appearance" && (
        <section className="settings-section" id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Theme" data-setting-id="appearance-theme" className={settingHighlightClass("appearance-theme").trim()}>
              <div className="theme-grid">
                {themes.map((t) => {
                  const contrastIssues = themeContrastIssues(t);
                  const isCustomTheme = customIds.has(t.id);
                  return (
                    <div className="theme-card-wrap" key={t.id}>
                    <button
                      key={t.id}
                      className={"theme-card" + (t.id === themeId ? " active" : "") + (contrastIssues.length ? " low-contrast" : "")}
                      onClick={() => setTheme(t.id)}
                      onDoubleClick={() => isCustomTheme && setEditing({ base: t, isNew: false })}
                      title={contrastIssues[0]}
                    >
                      <span
                        className="theme-preview"
                        style={{
                          background: t.background.image
                            ? `${t.background.image}, ${t.colors.bgPrimary}`
                            : t.colors.bgPrimary,
                        }}
                      >
                        <span
                          className="theme-panel"
                          style={{ background: t.colors.bgSecondary, borderColor: t.colors.borderPrimary }}
                        >
                          <span className="theme-dot" style={{ background: t.colors.accent }} />
                          <span className="theme-bar" style={{ background: t.colors.tertiaryText }} />
                        </span>
                      </span>
                      <span className="theme-name">
                        {t.name}
                        {t.id === themeId && <Check size={13} />}
                      </span>
                    </button>
                    {isCustomTheme && (
                      <button
                        className="theme-edit-button"
                        type="button"
                        onClick={() => setEditing({ base: t, isNew: false })}
                        aria-label={`Edit ${t.name}`}
                        title={`Edit ${t.name}`}
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                    </div>
                  );
                })}

                <button className="theme-card new-card" onClick={() => setEditing({ base: current, isNew: true })}>
                  <span className="theme-preview new">
                    <PlusSquare size={22} />
                  </span>
                  <span className="theme-name">Customize...</span>
                </button>
              </div>

              {custom.length > 0 && <p className="sheet-hint">Double-click a custom theme to edit or delete it.</p>}
            </SettingsBlock>
            <SettingsBlock title="Chat surface" data-setting-id="appearance-chat-surface" className={settingHighlightClass("appearance-chat-surface").trim()}>
              <div className="setting-stack">
                <div className="setting-field">
                  <span className="setting-mini-title">Layout</span>
                  <AppearanceChatLayoutChoices
                    value={chatLayoutStyle}
                    onChange={setChatLayoutStyle}
                  />
                </div>
                <div className="setting-field">
                  <span className="setting-mini-title">Message width</span>
                  <AppearanceMessageWidthChoices
                    value={messageWidth}
                    onChange={setMessageWidth}
                  />
                </div>
                <div className="setting-field">
                  <span className="setting-mini-title">Avatars</span>
                  <AppearanceAvatarChoices
                    value={avatarStyle}
                    onChange={setAvatarStyle}
                  />
                </div>
              </div>
            </SettingsBlock>
            <SettingsBlock title="Code blocks" data-setting-id="appearance-code-blocks" className={settingHighlightClass("appearance-code-blocks").trim()}>
              <AppearanceCodeBlockThemeChoices
                value={codeBlockTheme}
                onChange={setCodeBlockTheme}
              />
            </SettingsBlock>
            <SettingsBlock title="Interface sounds" data-setting-id="appearance-interface-sounds" className={settingHighlightClass("appearance-interface-sounds").trim()}>
              <div className="setting-stack">
                <div className="setting-toggle-row">
                  <div>
                    <strong>Enable sounds</strong>
                    <span>Locally synthesized alerts, off by default.</span>
                  </div>
                  <Toggle
                    checked={interfaceSounds}
                    onChange={setInterfaceSounds}
                    ariaLabel="Enable interface sounds"
                    testId="interface-sounds-toggle"
                  />
                </div>
                {interfaceSounds && (
                  <>
                    <div className="setting-toggle-row">
                      <div>
                        <strong>Needs attention</strong>
                        <span>Tool approvals, proposed worker plans, and terminal errors.</span>
                      </div>
                      <Toggle checked={soundOnAttention} onChange={setSoundOnAttention} ariaLabel="Needs attention sounds" testId="attention-sounds-toggle" />
                    </div>
                    {soundOnAttention && (
                      <div className="setting-field">
                        <span className="setting-mini-title">Attention sound</span>
                        <div className="setting-field-action">
                          <Select
                            value={attentionSound}
                            options={ATTENTION_SOUND_OPTIONS.map((value) => ({ value, label: SOUND_LABELS[value] }))}
                            onChange={(value) => setAttentionSound(value as AttentionSound)}
                            testId="attention-sound-select"
                          />
                          <button type="button" className="btn-ghost" onClick={() => playInterfaceSound(attentionSound)}>Preview</button>
                        </div>
                      </div>
                    )}
                    <div className="setting-toggle-row">
                      <div>
                        <strong>Finished</strong>
                        <span>A visible active chat completes, including its queued messages.</span>
                      </div>
                      <Toggle checked={soundOnFinished} onChange={setSoundOnFinished} ariaLabel="Finished sounds" testId="finished-sounds-toggle" />
                    </div>
                    {soundOnFinished && (
                      <div className="setting-field">
                        <span className="setting-mini-title">Finished sound</span>
                        <div className="setting-field-action">
                          <Select
                            value={finishedSound}
                            options={FINISHED_SOUND_OPTIONS.map((value) => ({ value, label: SOUND_LABELS[value] }))}
                            onChange={(value) => setFinishedSound(value as FinishedSound)}
                            testId="finished-sound-select"
                          />
                          <button type="button" className="btn-ghost" onClick={() => playInterfaceSound(finishedSound)}>Preview</button>
                        </div>
                      </div>
                    )}
                    <div className="setting-toggle-row">
                      <div>
                        <strong>Interaction feedback</strong>
                        <span>Optional cues for toggles, menus, dismissals, and primary actions.</span>
                      </div>
                      <Toggle checked={soundOnInteractions} onChange={setSoundOnInteractions} ariaLabel="Interaction feedback sounds" testId="interaction-sounds-toggle" />
                    </div>
                  </>
                )}
              </div>
            </SettingsBlock>
            {activeBackgroundImage && (
              <SettingsBlock title="Background image" data-setting-id="appearance-background" className={settingHighlightClass("appearance-background").trim()}>
                <AppearanceBackgroundImageChoices
                  backgroundImage={activeBackgroundImage}
                  fit={backgroundFit}
                  treatment={backgroundTreatment}
                  onFitChange={setBackgroundFit}
                  onTreatmentChange={setBackgroundTreatment}
                />
              </SettingsBlock>
            )}
          </SettingsPanel>
        </section>
            )}

            {activeSection === "system" && (
        <section className="settings-section" id="settings-panel-system" role="tabpanel" aria-labelledby="settings-tab-system" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Keyboard shortcuts" data-setting-id="system-shortcuts" className={settingHighlightClass("system-shortcuts").trim()}>
              <div className="setting-stack">
                {APP_SHORTCUT_ACTIONS.map((action) => (
                  <div className="shortcut-recorder-row" key={action}>
                    <div>
                      <strong>{APP_SHORTCUT_LABELS[action]}</strong>
                      <span>{recordingShortcut === action ? "Press a key combination..." : shortcutLabel(appShortcuts[action])}</span>
                    </div>
                    <button
                      className={"btn-ghost shortcut-recorder-button" + (recordingShortcut === action ? " active" : "")}
                      type="button"
                      data-shortcut-recorder="true"
                      data-testid={`app-shortcut-${action}`}
                      aria-pressed={recordingShortcut === action}
                      onClick={() => startRecordingShortcut(action)}
                    >
                      {recordingShortcut === action ? "Recording" : "Change"}
                    </button>
                  </div>
                ))}
                <div className="settings-action-row">
                  <div>
                    <strong>Shortcut defaults</strong>
                    <span>Restore Milim's default app-window shortcuts.</span>
                  </div>
                  <button
                    className="btn-ghost"
                    type="button"
                    data-testid="app-shortcuts-reset"
                    onClick={() => {
                      resetAppShortcuts();
                      setRecordingShortcut(null);
                      setShortcutError(null);
                    }}
                  >
                    Reset
                  </button>
                </div>
                {shortcutError && <p className="sheet-hint error">{shortcutError}</p>}
              </div>
            </SettingsBlock>
          </SettingsPanel>
        </section>
            )}

            {activeSection === "mobile" && (
        <section className="settings-section" id="settings-panel-mobile" role="tabpanel" aria-labelledby="settings-tab-mobile" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Mobile companion" data-setting-id="mobile-companion" className={settingHighlightClass("mobile-companion").trim()}>
              <MobileCompanionSettings />
            </SettingsBlock>
          </SettingsPanel>
        </section>
            )}

            {activeSection === "about" && (
        <section className="settings-section" id="settings-panel-about" role="tabpanel" aria-labelledby="settings-tab-about" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Version" data-setting-id="about-version" className={settingHighlightClass("about-version").trim()}>
              <div className="settings-action-row">
                <div>
                  <strong>Current version</strong>
                  <span>{currentVersionLabel}</span>
                </div>
              </div>
              <div className="settings-action-row">
                <div>
                  <strong>Latest version</strong>
                  <span>{latestVersionLabel}</span>
                </div>
              </div>
              <div className="settings-action-row">
                <div>
                  <strong>Last checked</strong>
                  <span>{updateLastCheckedAt ? new Date(updateLastCheckedAt).toLocaleString() : "Never"}</span>
                </div>
              </div>
            </SettingsBlock>

            <SettingsBlock title="Updates" data-setting-id="about-updates" className={settingHighlightClass("about-updates").trim()}>
              <div className="settings-action-row">
                <div>
                  <strong>{updateStatusLabel(updateStatus)}</strong>
                  <span>{updateError || (updatePath ? "Downloaded and ready to install." : "Checks GitHub Releases for portable app updates.")}</span>
                </div>
                <button className="btn-ghost" type="button" onClick={checkUpdatesFromSettings} disabled={!canCheckForUpdate}>
                  <Refresh size={13} />
                  Check
                </button>
              </div>
              {(updateStatus === "downloading" || updateStatus === "installing") ? (
                <UpdateProgress
                  className="settings-update-progress"
                  progress={updateProgress ?? {
                    phase: updateStatus === "installing" ? "restarting" : "downloading",
                    downloadedBytes: 0,
                    totalBytes: null,
                  }}
                />
              ) : null}
              {canDownloadUpdate ? (
                <div className="settings-action-row">
                  <div>
                    <strong>Download update</strong>
                    <span>Verify the package checksum before staging it locally.</span>
                  </div>
                  <button className="btn-ghost" type="button" onClick={downloadUpdateFromSettings}>
                    <Download size={13} />
                    Download
                  </button>
                </div>
              ) : null}
              {canInstallUpdate ? (
                <div className="settings-action-row">
                  <div>
                    <strong>Restart to update</strong>
                    <span>milim will close, replace the app, and reopen.</span>
                  </div>
                  <button className="btn-ghost" type="button" onClick={installUpdateFromSettings}>
                    Restart
                  </button>
                </div>
              ) : null}
              {updateInfo?.publishedAt ? <p>Released {new Date(updateInfo.publishedAt).toLocaleString()}.</p> : null}
              {updateInfo?.notes ? (
                <details className="settings-contract">
                  <summary>Release notes</summary>
                  <p>{updateInfo.notes}</p>
                </details>
              ) : null}
            </SettingsBlock>

            <SettingsBlock title="Diagnostics" data-setting-id="about-diagnostics" className={settingHighlightClass("about-diagnostics").trim()}>
              <div className="settings-action-row">
                <div>
                  <strong>Local logs</strong>
                  <span>Milim keeps two bounded log files on this device. Logs are never uploaded automatically.</span>
                </div>
                <button className="btn-ghost" type="button" data-testid="open-diagnostics" onClick={() => void openLogsFromSettings()}>
                  <FolderOpen size={13} />
                  Open logs
                </button>
              </div>
              {diagnosticsError && <p className="sheet-hint error" role="alert">{diagnosticsError}</p>}
            </SettingsBlock>
          </SettingsPanel>
        </section>
            )}

            {activeSection === "developer" && (
        <section className="settings-section" id="settings-panel-developer" role="tabpanel" aria-labelledby="settings-tab-developer" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Mode" data-setting-id="developer-mode" className={settingHighlightClass("developer-mode").trim()}>
              <div className="setting-toggle-row">
                <div>
                  <strong>Developer mode</strong>
                  <span>Show developer-only settings for testing setup flows.</span>
                </div>
                <Toggle checked={developerMode} onChange={setDeveloperMode} testId="general-developer-mode-toggle" />
              </div>
            </SettingsBlock>

            {developerMode && (
            <SettingsBlock title="Experimental">
              <div className="setting-stack">
                <div className="setting-toggle-row">
                  <div>
                    <strong>Hashline file patching</strong>
                    <span>Expose anchored read and patch tools to agent runs.</span>
                  </div>
                  <Toggle
                    checked={experimentalHashlinePatch}
                    onChange={setExperimentalHashlinePatch}
                    testId="developer-hashline-patch-toggle"
                  />
                </div>
              </div>
            </SettingsBlock>
            )}

            {developerMode && (
            <SettingsBlock title="Onboarding">
              <div className="setting-stack">
                <div className="setting-toggle-row">
                  <div>
                    <strong>Onboarding flow</strong>
                    <span>Open the first-run setup sheet for testing. Turning this off dismisses the active flow.</span>
                  </div>
                  <Toggle
                    checked={onboardingDeveloperShow || onboardingStatus === "in_progress"}
                    onChange={setDeveloperShowOnboarding}
                    testId="developer-onboarding-toggle"
                  />
                </div>
                <div className="settings-action-row">
                  <div>
                    <strong>Onboarding state</strong>
                    <span>
                      {onboardingStatus} / {onboardingSetupLabel(onboardingSetupPath)}
                    </span>
                  </div>
                  <button className="btn-ghost" type="button" onClick={() => setDeveloperShowOnboarding(true)} data-testid="developer-open-onboarding">
                    Open now
                  </button>
                </div>
                <div className="settings-action-row">
                  <div>
                    <strong>Completion</strong>
                    <span>
                      Completed {timestampLabel(onboardingCompletedAt)} / dismissed {timestampLabel(onboardingDismissedAt)}
                    </span>
                  </div>
                  <button className="btn-ghost" type="button" onClick={completeOnboarding} data-testid="developer-complete-onboarding">
                    Mark complete
                  </button>
                </div>
                <div className="settings-action-row">
                  <div>
                    <strong>Reset first-run state</strong>
                    <span>Clear onboarding choices so automatic first-run gating can run again.</span>
                  </div>
                  <button className="btn-ghost danger" type="button" onClick={resetOnboarding} data-testid="developer-reset-onboarding">
                    Reset
                  </button>
                </div>
              </div>
            </SettingsBlock>
            )}
          </SettingsPanel>
        </section>
            )}
          </div>
          </div>
        </div>
      </SheetDialog>
  );
}
