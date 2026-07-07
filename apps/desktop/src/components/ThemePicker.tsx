import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  checkVoiceSetup,
  listModelsDetailed,
  installKokoroPreset,
  installPiperExecutable,
  installPiperPreset,
  installVadPreset,
  speakText,
  testVoiceActivity,
  testVoiceTranscription,
  type KokoroPresetInstallProgress,
  type ModelInfo,
  type PiperExecutableInstallProgress,
  type PiperPresetInstallProgress,
  type VadPresetInstallProgress,
  type VoiceSetupTarget,
} from "../api";
import { isThreadNamingModel } from "../lib/threadTitles";
import {
  KOKORO_PRESETS,
  PIPER_PRESETS,
  STT_OPTIONS,
  TTS_OPTIONS,
  VAD_PRESETS,
  useSettings,
  voiceProviderConfigIssue,
  voiceTtsConfigIssue,
  voiceVadConfigIssue,
  type ServerVadProvider,
  type TtsProvider,
  type VoiceSttProvider,
} from "../settings/store";
import { useTheme } from "../theme/store";
import type { Theme } from "../theme/types";
import { useOnboarding } from "../onboarding/store";
import { DAY_MS, useSessions, type ArchiveRetentionDays, type Project, type Session } from "../sessions/store";
import { useUpdateStore, type UpdateStatus } from "../update/store";
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
  DEFAULT_UI_SIZE,
  DEFAULT_PREVIEW_PANEL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_UI_SIZE,
  MIN_UI_SIZE,
  UI_SIZE_STEP,
  useUiPreferences,
  type AvatarStyle,
  type BackgroundFit,
  type BackgroundTreatment,
  type ChatLayoutStyle,
  type CodeBlockTheme,
  type ComposerDensity,
  type ComposerSendShortcut,
  type InterfaceMode,
  type MessageWidth,
} from "../ui/store";
import { featureVisibleInMode } from "../ui/features";
import { Archive, Check, Code, Download, Gear, GitLogo, Pencil, PlusSquare, Refresh, Search, Sidebar, Smartphone, Sun, Trash, Volume2, X } from "./icons";
import { MobileCompanionSettings } from "./MobileCompanionSettings";
import { SheetDialog } from "./SheetDialog";
import { ThemeEditor } from "./ThemeEditor";
import { Select, Slider, Toggle } from "./ui";

type SettingsSectionId = "app" | "chat" | "audio" | "appearance" | "history" | "mobile" | "system" | "about" | "developer";

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  detail: string;
  icon: typeof Gear;
  search: string[];
};
type SettingsStatusTone = "ready" | "warn" | "muted";
type SettingsSectionActivation = { focusTab?: boolean; remember?: boolean };

let lastSettingsSection: SettingsSectionId = "app";

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "app",
    label: "App",
    detail: "Mode, window behavior, and layout",
    icon: Sidebar,
    search: ["app", "general", "mode", "simple", "workbench", "window", "layout", "ui size", "zoom", "scale", "100", "percent", "sidebar", "new chat", "bottom", "always on top", "pin", "panel", "width", "reset"],
  },
  {
    id: "chat",
    label: "Chat",
    detail: "Composer behavior and thread naming",
    icon: Pencil,
    search: ["chat", "composer", "send", "enter", "ctrl enter", "cmd enter", "density", "auto title", "ai title", "thread name", "naming model"],
  },
  {
    id: "audio",
    label: "Audio",
    detail: "Voice input, speech output, and diagnostics",
    icon: Volume2,
    search: ["audio", "voice", "speech", "stt", "tts", "transcription", "recording", "whisper", "openai", "remote", "parakeet", "vad", "hotkey", "dictation", "speaker", "piper", "kokoro", "native", "speed", "preview"],
  },
  {
    id: "appearance",
    label: "Appearance",
    detail: "Themes and custom styles",
    icon: Sun,
    search: ["theme", "themes", "dark", "light", "custom", "color", "style", "visual", "chat layout", "bubbles", "width", "avatar", "code", "background"],
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
function settingsIssueLabel(issue: string | null): string {
  if (!issue) return "Needs setup";
  const message = issue.toLowerCase();
  if (message.includes("endpoint")) return "Needs endpoint";
  if (message.includes("model path") || message.includes("model")) return "Needs model";
  if (message.includes("command")) return "Needs command";
  if (message.includes("threshold")) return "Check threshold";
  if (message.includes("speed")) return "Check speed";
  return "Needs setup";
}

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

function SettingsPanel({ children }: { children: ReactNode }) {
  return <div className="settings-panel">{children}</div>;
}

function SettingsBlock({ title, className = "", children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <div className={`settings-block${className ? ` ${className}` : ""}`}>
      <div className="settings-block-title">{title}</div>
      {children}
    </div>
  );
}

function SettingsChoiceGroup<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix,
}: {
  value: T;
  options: Array<{ value: T; label: string; detail: string }>;
  onChange: (value: T) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="settings-choice-grid">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            className={"settings-choice-button" + (selected ? " active" : "")}
            type="button"
            data-testid={`${testIdPrefix}-${option.value}`}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            <small>{option.detail}</small>
          </button>
        );
      })}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

export function ThemePicker({ onClose }: { onClose: () => void }) {
  const themes = useTheme((s) => s.themes);
  const custom = useTheme((s) => s.custom);
  const themeId = useTheme((s) => s.themeId);
  const current = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const voice = useSettings((s) => s.voice);
  const setVoiceSettings = useSettings((s) => s.setVoiceSettings);
  const sidebarOpen = useUiPreferences((s) => s.sidebarOpen);
  const sidebarWidth = useUiPreferences((s) => s.sidebarWidth);
  const previewPanelWidth = useUiPreferences((s) => s.previewPanelWidth);
  const uiSize = useUiPreferences((s) => s.uiSize);
  const windowAlwaysOnTop = useUiPreferences((s) => s.windowAlwaysOnTop);
  const composerSendShortcut = useUiPreferences((s) => s.composerSendShortcut);
  const composerDensity = useUiPreferences((s) => s.composerDensity);
  const autoTitleChats = useUiPreferences((s) => s.autoTitleChats);
  const aiThreadNames = useUiPreferences((s) => s.aiThreadNames);
  const aiThreadNameModel = useUiPreferences((s) => s.aiThreadNameModel);
  const newChatButtonAtBottom = useUiPreferences((s) => s.newChatButtonAtBottom);
  const interfaceMode = useUiPreferences((s) => s.interfaceMode);
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
  const setWindowAlwaysOnTop = useUiPreferences((s) => s.setWindowAlwaysOnTop);
  const setComposerSendShortcut = useUiPreferences((s) => s.setComposerSendShortcut);
  const setComposerDensity = useUiPreferences((s) => s.setComposerDensity);
  const setAutoTitleChats = useUiPreferences((s) => s.setAutoTitleChats);
  const setAiThreadNames = useUiPreferences((s) => s.setAiThreadNames);
  const setAiThreadNameModel = useUiPreferences((s) => s.setAiThreadNameModel);
  const setNewChatButtonAtBottom = useUiPreferences((s) => s.setNewChatButtonAtBottom);
  const setInterfaceMode = useUiPreferences((s) => s.setInterfaceMode);
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
  const onboardingMode = useOnboarding((s) => s.selectedMode);
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
  const [audioTab, setAudioTab] = useState<"input" | "output">("input");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [confirmArchiveDelete, setConfirmArchiveDelete] = useState<string | null>(null);
  const [voiceTest, setVoiceTest] = useState<{ kind: "running" | "success" | "error"; message: string } | null>(null);
  const [vadTest, setVadTest] = useState<{ kind: "running" | "success" | "error"; message: string } | null>(null);
  const [ttsTest, setTtsTest] = useState<{ kind: "running" | "success" | "error"; message: string } | null>(null);
  const [installingPreset, setInstallingPreset] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<PiperPresetInstallProgress | null>(null);
  const installAbortRef = useRef<AbortController | null>(null);
  const [installingKokoroPreset, setInstallingKokoroPreset] = useState<string | null>(null);
  const [kokoroInstallProgress, setKokoroInstallProgress] = useState<KokoroPresetInstallProgress | null>(null);
  const kokoroInstallAbortRef = useRef<AbortController | null>(null);
  const [installingVadPreset, setInstallingVadPreset] = useState<string | null>(null);
  const [vadInstallProgress, setVadInstallProgress] = useState<VadPresetInstallProgress | null>(null);
  const vadInstallAbortRef = useRef<AbortController | null>(null);
  const [installingPiperExecutable, setInstallingPiperExecutable] = useState(false);
  const [executableInstallProgress, setExecutableInstallProgress] =
    useState<PiperExecutableInstallProgress | null>(null);
  const executableInstallAbortRef = useRef<AbortController | null>(null);
  const [threadNameModels, setThreadNameModels] = useState<ModelInfo[]>([]);
  const [recordingShortcut, setRecordingShortcut] = useState<AppShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [setupCheck, setSetupCheck] = useState<Record<VoiceSetupTarget, { kind: "running" | "success" | "error"; message: string } | null>>({
    stt: null,
    vad: null,
    tts: null,
  });
  const voiceConfigIssue = voiceProviderConfigIssue(voice);
  const vadConfigIssue = voiceVadConfigIssue(voice);
  const ttsConfigIssue = voiceTtsConfigIssue(voice);
  const showVoiceAdvanced = featureVisibleInMode("voiceAdvanced", interfaceMode);
  const voiceStatus =
    !voice.enabled
      ? { label: "Off", tone: "muted" as SettingsStatusTone }
      : voiceConfigIssue
        ? { label: settingsIssueLabel(voiceConfigIssue), tone: "warn" as SettingsStatusTone }
        : voice.serverVadEnabled && vadConfigIssue
          ? { label: settingsIssueLabel(vadConfigIssue), tone: "warn" as SettingsStatusTone }
          : { label: "Ready", tone: "ready" as SettingsStatusTone };
  const speechStatus =
    !voice.ttsEnabled
      ? { label: "Off", tone: "muted" as SettingsStatusTone }
      : ttsConfigIssue
        ? { label: settingsIssueLabel(ttsConfigIssue), tone: "warn" as SettingsStatusTone }
        : { label: "Ready", tone: "ready" as SettingsStatusTone };
  const archivedSessions = useMemo(
    () => sessions.filter((session) => session.archivedAt).slice().sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [sessions],
  );
  const archivedProjects = useMemo(
    () => projects.filter((project) => project.archivedAt).slice().sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [projects],
  );
  const archivedCount = archivedSessions.length + archivedProjects.length;
  const audioStatus =
    voiceStatus.tone === "warn"
      ? voiceStatus
      : speechStatus.tone === "warn"
        ? speechStatus
        : voice.enabled && voice.ttsEnabled
          ? { label: "Input + output", tone: "ready" as SettingsStatusTone }
          : voice.enabled
            ? { label: "Input on", tone: "ready" as SettingsStatusTone }
            : voice.ttsEnabled
              ? { label: "Output on", tone: "ready" as SettingsStatusTone }
              : { label: "Off", tone: "muted" as SettingsStatusTone };
  const systemStatus =
    updateStatus === "available" || updateStatus === "ready" || updateStatus === "error"
      ? { label: updateStatusLabel(updateStatus), tone: updateStatusTone(updateStatus) }
      : developerMode
        ? { label: "Developer on", tone: "ready" as SettingsStatusTone }
        : { label: updateStatusLabel(updateStatus), tone: updateStatusTone(updateStatus) };
  const sectionStatus: Record<SettingsSectionId, { label: string; tone: SettingsStatusTone }> = {
    app: { label: interfaceMode === "workbench" ? "Workbench" : "Simple", tone: "ready" },
    chat: { label: aiThreadNames ? "AI names" : "Manual names", tone: "ready" },
    audio: audioStatus,
    appearance: { label: current.name, tone: "ready" },
    history: { label: archivedCount ? `${archivedCount} archived` : "Empty", tone: archivedCount ? "warn" : "muted" },
    mobile: { label: "Relay", tone: "muted" },
    system: { label: "Shortcuts", tone: "ready" },
    about: systemStatus,
    developer: { label: developerMode ? "On" : "Off", tone: developerMode ? "ready" : "muted" },
  };
  const visibleSettingsSections = SETTINGS_SECTIONS;
  const sectionStatusKey = `${interfaceMode}\n${windowAlwaysOnTop}\n${uiSize}\n${composerSendShortcut}\n${Object.values(appShortcuts).join("\n")}\n${aiThreadNames}\n${aiThreadNameModel}\n${developerMode}\n${experimentalHashlinePatch}\n${onboardingStatus}\n${onboardingDeveloperShow}\n${audioStatus.label}\n${audioStatus.tone}\n${systemStatus.label}\n${systemStatus.tone}\n${archivedCount}\n${archiveRetentionDays}\n${current.name}\n${updateStatus}\n${chatLayoutStyle}\n${messageWidth}\n${avatarStyle}\n${codeBlockTheme}\n${backgroundFit}\n${backgroundTreatment}`;
  const normalizedSettingsQuery = settingsQuery.trim().toLowerCase();
  const filteredSettingsSections = useMemo(() => {
    if (!normalizedSettingsQuery) return visibleSettingsSections;
    return visibleSettingsSections.filter((section) => {
      const status = sectionStatus[section.id];
      return [section.id, section.label, section.detail, status.label, ...section.search]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSettingsQuery);
    });
  }, [normalizedSettingsQuery, sectionStatusKey, visibleSettingsSections]);
  const voiceConfigKey = [
    voice.provider,
    voice.whisperModelPath,
    voice.openAiEndpoint,
    voice.openAiModel,
    voice.remoteEndpoint,
    voice.parakeetCommand,
    voice.parakeetModel,
    voice.vadEnabled,
    voice.vadSilenceMs,
    voice.maxRecordingSeconds,
    voice.hotkeyEnabled,
    voice.hotkeyShortcut,
    voice.dictationInjectText,
    voice.serverVadEnabled,
    voice.serverVadProvider,
    voice.serverVadModelPath,
    voice.serverVadThreshold,
  ].join("\n");
  const ttsConfigKey = [
    voice.ttsEnabled,
    voice.ttsProvider,
    voice.ttsCommand,
    voice.ttsOpenAiEndpoint,
    voice.ttsOpenAiModel,
    voice.ttsOpenAiApiKey,
    voice.piperCommand,
    voice.piperModelPath,
    voice.nativeTtsEngine,
    voice.nativeTtsModelPath,
    voice.nativeTtsConfigPath,
    voice.ttsVoice,
    voice.ttsSpeed,
  ].join("\n");
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
    setVoiceTest(null);
    setVadTest(null);
    setSetupCheck((current) => ({ ...current, stt: null, vad: null }));
  }, [voiceConfigKey]);

  useEffect(() => {
    setTtsTest(null);
    setSetupCheck((current) => ({ ...current, tts: null }));
  }, [ttsConfigKey]);

  useEffect(() => {
    if (!recordingShortcut) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => recordAppShortcut(recordingShortcut, event);
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [appShortcuts, recordingShortcut]);

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

  const visibleTtsOptions = showVoiceAdvanced
    ? TTS_OPTIONS
    : TTS_OPTIONS.filter((option) => option.id === "openai" || option.id === "command" || option.id === voice.ttsProvider);
  const customIds = new Set(custom.map((c) => c.id));
  const installPct =
    installProgress?.total && installProgress.downloaded != null
      ? Math.round((installProgress.downloaded / installProgress.total) * 100)
      : null;
  const installPhaseLabel = installProgress?.phase === "config" ? "Config" : "Model";
  const kokoroInstallPct =
    kokoroInstallProgress?.total && kokoroInstallProgress.downloaded != null
      ? Math.round((kokoroInstallProgress.downloaded / kokoroInstallProgress.total) * 100)
      : null;
  const kokoroInstallPhaseLabel =
    kokoroInstallProgress?.phase === "voice" ? "Voice" : kokoroInstallProgress?.phase === "config" ? "Config" : "Model";
  const vadInstallPct =
    vadInstallProgress?.total && vadInstallProgress.downloaded != null
      ? Math.round((vadInstallProgress.downloaded / vadInstallProgress.total) * 100)
      : null;
  const executableInstallPct =
    executableInstallProgress?.total && executableInstallProgress.downloaded != null
      ? Math.round((executableInstallProgress.downloaded / executableInstallProgress.total) * 100)
      : null;
  const executableInstallPhaseLabel = executableInstallProgress?.phase === "extract" ? "Extract" : "Archive";
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

  async function pickWhisperModel() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Choose Whisper model",
        filters: [
          { name: "Whisper ggml models", extensions: ["bin"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (typeof selected === "string" && selected.trim()) {
        setVoiceSettings({ whisperModelPath: selected });
      }
    } catch {
      setVoiceTest({ kind: "error", message: "Whisper model picker is unavailable in this environment." });
    }
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

  async function testVoiceProvider() {
    if (voiceConfigIssue) {
      setVoiceTest({ kind: "error", message: voiceConfigIssue });
      return;
    }
    setVoiceTest({ kind: "running", message: "Testing STT provider..." });
    try {
      const transcript = await testVoiceTranscription(voice);
      setVoiceTest({
        kind: "success",
        message: transcript.trim()
          ? `Test transcript: ${transcript.trim()}`
          : "Provider responded; the silence test returned no text.",
      });
    } catch (e) {
      setVoiceTest({
        kind: "error",
        message: `Test failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async function testVadProvider() {
    if (vadConfigIssue) {
      setVadTest({ kind: "error", message: vadConfigIssue });
      return;
    }
    setVadTest({ kind: "running", message: "Testing VAD..." });
    try {
      const activity = await testVoiceActivity(voice);
      const score = Math.round(activity.speech_probability * 100);
      setVadTest({
        kind: activity.is_speech ? "error" : "success",
        message: activity.is_speech
          ? `Silent test was marked speech (${score}%).`
          : `Silent test rejected (${score}%).`,
      });
    } catch (e) {
      setVadTest({
        kind: "error",
        message: `Test failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async function runSetupCheck(target: VoiceSetupTarget) {
    setSetupCheck((current) => ({
      ...current,
      [target]: { kind: "running", message: "Checking setup..." },
    }));
    try {
      const message = await checkVoiceSetup(voice, target);
      setSetupCheck((current) => ({
        ...current,
        [target]: { kind: "success", message },
      }));
    } catch (e) {
      setSetupCheck((current) => ({
        ...current,
        [target]: {
          kind: "error",
          message: `Check failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      }));
    }
  }

  async function testTtsPlayback() {
    if (ttsConfigIssue) {
      setTtsTest({ kind: "error", message: ttsConfigIssue });
      return;
    }
    setTtsTest({ kind: "running", message: "Testing voice..." });
    try {
      const blob = await speakText("This is a milim text-to-speech test.", voice);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => URL.revokeObjectURL(url);
      await audio.play();
      setTtsTest({ kind: "success", message: "Test voice playback started." });
    } catch (e) {
      setTtsTest({
        kind: "error",
        message: `Test failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async function installPreset(preset: (typeof PIPER_PRESETS)[number]) {
    if (installingPreset) return;
    const ctrl = new AbortController();
    installAbortRef.current = ctrl;
    setInstallingPreset(preset.id);
    setInstallProgress({ phase: "model", downloaded: 0, total: null });
    setTtsTest({ kind: "running", message: `Installing ${preset.name}...` });
    try {
      const installed = await installPiperPreset(preset, setInstallProgress, ctrl.signal);
      setVoiceSettings({
        ttsEnabled: true,
        ttsProvider: "piper",
        piperModelPath: installed.model_path,
      });
      setTtsTest({ kind: "success", message: installed.message || `Installed ${preset.name}.` });
    } catch (e) {
      setInstallProgress(null);
      if (e instanceof DOMException && e.name === "AbortError") {
        setTtsTest({ kind: "error", message: "Install canceled." });
      } else {
        setTtsTest({
          kind: "error",
          message: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } finally {
      installAbortRef.current = null;
      setInstallingPreset(null);
    }
  }

  function cancelPresetInstall() {
    installAbortRef.current?.abort();
  }

  async function installKokoro(preset: (typeof KOKORO_PRESETS)[number]) {
    if (installingKokoroPreset) return;
    const ctrl = new AbortController();
    kokoroInstallAbortRef.current = ctrl;
    setInstallingKokoroPreset(preset.id);
    setKokoroInstallProgress({ phase: "model", downloaded: 0, total: null });
    setTtsTest({ kind: "running", message: `Installing ${preset.name}...` });
    try {
      const installed = await installKokoroPreset(preset, setKokoroInstallProgress, ctrl.signal);
      setVoiceSettings({
        ttsEnabled: true,
        ttsProvider: "native",
        nativeTtsEngine: "kokoro",
        nativeTtsModelPath: installed.model_path,
        nativeTtsConfigPath: installed.config_path,
        ttsVoice: installed.voice || preset.voice,
      });
      setTtsTest({ kind: "success", message: installed.message || `Installed ${preset.name}.` });
    } catch (e) {
      setKokoroInstallProgress(null);
      if (e instanceof DOMException && e.name === "AbortError") {
        setTtsTest({ kind: "error", message: "Install canceled." });
      } else {
        setTtsTest({
          kind: "error",
          message: `Install failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } finally {
      kokoroInstallAbortRef.current = null;
      setInstallingKokoroPreset(null);
    }
  }

  function cancelKokoroInstall() {
    kokoroInstallAbortRef.current?.abort();
  }

  async function installVad(preset: (typeof VAD_PRESETS)[number]) {
    if (installingVadPreset) return;
    const ctrl = new AbortController();
    vadInstallAbortRef.current = ctrl;
    setInstallingVadPreset(preset.id);
    setVadInstallProgress({ phase: "model", downloaded: 0, total: null });
    setVadTest({ kind: "running", message: `Installing ${preset.name}...` });
    try {
      const installed = await installVadPreset(preset, setVadInstallProgress, ctrl.signal);
      setVoiceSettings({
        serverVadEnabled: true,
        serverVadProvider: "native",
        serverVadModelPath: installed.model_path,
      });
      setVadTest({ kind: "success", message: installed.message || `Installed ${preset.name}.` });
    } catch (e) {
      setVadInstallProgress(null);
      if (e instanceof DOMException && e.name === "AbortError") {
        setVadTest({ kind: "error", message: "VAD install canceled." });
      } else {
        setVadTest({
          kind: "error",
          message: `VAD install failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } finally {
      vadInstallAbortRef.current = null;
      setInstallingVadPreset(null);
    }
  }

  function cancelVadInstall() {
    vadInstallAbortRef.current?.abort();
  }

  async function installPiperCommand() {
    if (installingPiperExecutable) return;
    const ctrl = new AbortController();
    executableInstallAbortRef.current = ctrl;
    setInstallingPiperExecutable(true);
    setExecutableInstallProgress({ phase: "archive", downloaded: 0, total: null });
    setTtsTest({ kind: "running", message: "Installing Piper executable..." });
    try {
      const installed = await installPiperExecutable(setExecutableInstallProgress, ctrl.signal);
      setVoiceSettings({
        ttsEnabled: true,
        ttsProvider: "piper",
        piperCommand: installed.executable_path,
      });
      setTtsTest({ kind: "success", message: installed.message || "Piper executable installed." });
    } catch (e) {
      setExecutableInstallProgress(null);
      if (e instanceof DOMException && e.name === "AbortError") {
        setTtsTest({ kind: "error", message: "Piper install canceled." });
      } else {
        setTtsTest({
          kind: "error",
          message: `Piper install failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } finally {
      executableInstallAbortRef.current = null;
      setInstallingPiperExecutable(false);
    }
  }

  function cancelPiperExecutableInstall() {
    executableInstallAbortRef.current?.abort();
  }

  function recordAppShortcut(action: AppShortcutAction, event: globalThis.KeyboardEvent) {
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
    const conflict = shortcutConflict(appShortcuts, action, shortcut);
    if (conflict) {
      setShortcutError(`${shortcutLabel(shortcut)} is already used by ${APP_SHORTCUT_LABELS[conflict]}.`);
      return;
    }
    if (!setAppShortcut(action, shortcut)) {
      setShortcutError("Shortcut could not be saved.");
      return;
    }
    setRecordingShortcut(null);
    setShortcutError(null);
  }

  function startRecordingShortcut(action: AppShortcutAction) {
    setRecordingShortcut((current) => current === action ? null : action);
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
                    aria-current={selected ? "page" : undefined}
                    onClick={() => selectSettingsSection(section.id)}
                    onKeyDown={onSettingsNavKeyDown}
                  >
                    <span className="settings-nav-icon" aria-hidden="true">
                      <Icon size={15} />
                    </span>
                    <span className="settings-nav-copy">
                      <span className="settings-nav-label">{section.label}</span>
                    </span>
                  </button>
                );
              })}
              {filteredSettingsSections.length === 0 ? (
                <div className="settings-nav-empty">No settings match.</div>
              ) : null}
            </div>
          </nav>

          <div className="settings-detail">
            <div className="settings-detail-head">
              <div>
                <h3>{activeSettingsSection.label}</h3>
                <p>{activeSettingsSection.detail}</p>
              </div>
              <div className="settings-section-actions">
                {activeSection === "audio" ? (
                  <>
                    <span className={`settings-status-pill ${voiceStatus.tone}`}>Input {voiceStatus.label.toLowerCase()}</span>
                    <span className={`settings-status-pill ${speechStatus.tone}`}>Output {speechStatus.label.toLowerCase()}</span>
                    <Toggle checked={voice.enabled} onChange={(enabled) => setVoiceSettings({ enabled })} testId="voice-enabled-toggle" />
                    <Toggle checked={voice.ttsEnabled} onChange={(ttsEnabled) => setVoiceSettings({ ttsEnabled })} testId="tts-enabled-toggle" />
                  </>
                ) : (
                  <span className={`settings-status-pill ${sectionStatus[activeSection].tone}`}>{sectionStatus[activeSection].label}</span>
                )}
              </div>
            </div>

            <div className="settings-content">
            {activeSection === "app" && (
        <section className="settings-section" id="settings-panel-app" role="tabpanel" aria-labelledby="settings-tab-app" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Interface">
              <div className="setting-stack">
                <div className="setting-field">
                  <span className="setting-mini-title">Mode</span>
                  <SettingsChoiceGroup<InterfaceMode>
                    value={interfaceMode}
                    onChange={setInterfaceMode}
                    testIdPrefix="general-interface-mode"
                    options={[
                      {
                        value: "simple",
                        label: "Simple",
                        detail: "Polished chat, model switching, themes, memory, and voice basics.",
                      },
                      {
                        value: "workbench",
                        label: "Workbench",
                        detail: "Agents, tools, schedules, MCP, media, and local runtime setup.",
                      },
                    ]}
                  />
                </div>
              </div>
            </SettingsBlock>

            <SettingsBlock title="Window and layout">
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
            <SettingsBlock title="Composer">
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

            <SettingsBlock title="Threads">
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
            <SettingsBlock title="Retention">
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

            <SettingsBlock title="Projects">
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
                            <Trash size={13} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SettingsBlock>

            <SettingsBlock title="Chats">
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
                            <Trash size={13} />
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

            {activeSection === "audio" && (
        <section className="settings-section" id="settings-panel-audio" role="tabpanel" aria-labelledby="settings-tab-audio" tabIndex={-1}>
          <div className="settings-subtabs" role="tablist" aria-label="Audio settings">
            <button
              className={"settings-subtab" + (audioTab === "input" ? " active" : "")}
              type="button"
              role="tab"
              aria-selected={audioTab === "input"}
              onClick={() => setAudioTab("input")}
            >
              Input
            </button>
            <button
              className={"settings-subtab" + (audioTab === "output" ? " active" : "")}
              type="button"
              role="tab"
              data-testid="audio-output-tab"
              aria-selected={audioTab === "output"}
              onClick={() => setAudioTab("output")}
            >
              Output
            </button>
          </div>

          {audioTab === "input" && (
          <SettingsPanel>
            <SettingsBlock title="Provider">
              <div className="stt-grid">
                {STT_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    className={"stt-card" + (voice.provider === option.id ? " active" : "")}
                    onClick={() => setVoiceSettings({ provider: option.id as VoiceSttProvider })}
                    type="button"
                  >
                    <span className="stt-card-top">
                      <span>{option.label}</span>
                      <span className={"stt-badge" + (option.badge === "Planned" ? " planned" : "")}>{option.badge}</span>
                    </span>
                    <span className="stt-detail">{option.detail}</span>
                  </button>
                ))}
              </div>
            </SettingsBlock>

            <SettingsBlock title="Setup">

          {voice.provider === "whisper" && (
            <label className="setting-field">
              <span>Whisper model path</span>
              <span className="setting-field-row">
                <input
                  value={voice.whisperModelPath}
                  onChange={(e) => setVoiceSettings({ whisperModelPath: e.target.value })}
                  placeholder="C:/models/ggml-base.en.bin"
                />
                <button className="btn-ghost" type="button" onClick={pickWhisperModel}>
                  Choose model
                </button>
              </span>
            </label>
          )}

          {voice.provider === "remote" && (
            <label className="setting-field">
              <span>Remote STT endpoint</span>
              <input
                value={voice.remoteEndpoint}
                onChange={(e) => setVoiceSettings({ remoteEndpoint: e.target.value })}
                placeholder="https://api.example.com/v1/audio/transcriptions"
              />
            </label>
          )}

          {voice.provider === "openai" && (
            <div className="setting-stack">
              <label className="setting-field">
                <span>OpenAI-compatible STT endpoint</span>
                <input
                  value={voice.openAiEndpoint}
                  onChange={(e) => setVoiceSettings({ openAiEndpoint: e.target.value })}
                  placeholder="https://api.openai.com/v1/audio/transcriptions"
                />
              </label>
              <label className="setting-field">
                <span>Model</span>
                <input
                  value={voice.openAiModel}
                  onChange={(e) => setVoiceSettings({ openAiModel: e.target.value })}
                  placeholder="gpt-4o-mini-transcribe"
                />
              </label>
              <label className="setting-field">
                <span>API key</span>
                <input
                  value={voice.openAiApiKey}
                  onChange={(e) => setVoiceSettings({ openAiApiKey: e.target.value })}
                  placeholder="Optional for local compatible endpoints"
                  type="password"
                />
              </label>
            </div>
          )}

          {voice.provider === "parakeet" && (
            <div className="setting-stack">
              <label className="setting-field">
                <span>Parakeet command</span>
                <input
                  value={voice.parakeetCommand}
                  onChange={(e) => setVoiceSettings({ parakeetCommand: e.target.value })}
                  placeholder="parakeet-transcribe"
                />
              </label>
              <label className="setting-field">
                <span>Model</span>
                <input
                  value={voice.parakeetModel}
                  onChange={(e) => setVoiceSettings({ parakeetModel: e.target.value })}
                  placeholder="nvidia/parakeet-tdt-0.6b-v2"
                />
              </label>
              <details className="settings-contract">
                <summary>Command contract</summary>
                <p>
                  Milim runs the executable as <code>{"--audio <wav> --model <model>"}</code>. Use a wrapper script for extra arguments; print plain text or JSON with <code>text</code>.
                </p>
              </details>
            </div>
          )}

            </SettingsBlock>

            <SettingsBlock title="Recording">
          <div className="setting-stack">
            <div className="setting-toggle-row">
              <div>
                <strong>Auto-stop on silence</strong>
                <span>End recording after the microphone stays quiet.</span>
              </div>
              <Toggle checked={voice.vadEnabled} onChange={(vadEnabled) => setVoiceSettings({ vadEnabled })} />
            </div>
            <div className="setting-field-row setting-field-pair">
              <label className="setting-field">
                <span>Silence window (ms)</span>
                <input
                  type="number"
                  min={300}
                  step={100}
                  value={voice.vadSilenceMs}
                  onChange={(e) => setVoiceSettings({ vadSilenceMs: Number(e.target.value) })}
                />
              </label>
              <label className="setting-field">
                <span>Max recording (sec)</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={voice.maxRecordingSeconds}
                  onChange={(e) => setVoiceSettings({ maxRecordingSeconds: Number(e.target.value) })}
                />
              </label>
            </div>
            {showVoiceAdvanced && (
              <>
                <div className="setting-toggle-row">
                  <div>
                    <strong>Global push-to-talk</strong>
                    <span>Hold a system-wide shortcut to record; release to transcribe.</span>
                  </div>
                  <Toggle
                    checked={voice.hotkeyEnabled}
                    onChange={(hotkeyEnabled) => setVoiceSettings({ hotkeyEnabled })}
                    testId="voice-hotkey-toggle"
                  />
                </div>
                <label className="setting-field">
                  <span>Shortcut</span>
                  <input
                    data-testid="voice-hotkey-shortcut"
                    value={voice.hotkeyShortcut}
                    onChange={(e) => setVoiceSettings({ hotkeyShortcut: e.target.value })}
                    placeholder="CommandOrControl+Shift+Space"
                    disabled={!voice.hotkeyEnabled}
                  />
                </label>
                <div className="setting-toggle-row">
                  <div>
                    <strong>Type into active app</strong>
                    <span>When using the global shortcut, send the transcript as keystrokes to the focused app.</span>
                  </div>
                  <Toggle
                    checked={voice.dictationInjectText}
                    onChange={(dictationInjectText) => setVoiceSettings({ dictationInjectText })}
                    testId="voice-dictation-toggle"
                  />
                </div>
              </>
            )}
          </div>

            </SettingsBlock>

            {showVoiceAdvanced && (
            <SettingsBlock title="Preflight">
          <div className="setting-stack">
            <div className="setting-toggle-row">
              <div>
                <strong>Server speech preflight</strong>
                <span>Check the finished clip before sending it to STT.</span>
              </div>
              <Toggle checked={voice.serverVadEnabled} onChange={(serverVadEnabled) => setVoiceSettings({ serverVadEnabled })} />
            </div>
            {voice.serverVadEnabled && (
              <>
                <div className="setting-field">
                  <span>VAD provider</span>
                  <div className="native-engine-row">
                    <button
                      className={"btn-ghost" + (voice.serverVadProvider === "energy" ? " active" : "")}
                      type="button"
                      onClick={() => setVoiceSettings({ serverVadProvider: "energy" as ServerVadProvider })}
                    >
                      Energy
                    </button>
                    <button
                      className={"btn-ghost" + (voice.serverVadProvider === "native" ? " active" : "")}
                      type="button"
                      onClick={() => setVoiceSettings({ serverVadProvider: "native" as ServerVadProvider })}
                    >
                      Native ONNX
                    </button>
                  </div>
                </div>
                <div className="setting-field-row setting-field-pair">
                  <label className="setting-field">
                    <span>Energy threshold</span>
                    <input
                      type="number"
                      min={0.001}
                      step={0.001}
                      value={voice.serverVadThreshold}
                      onChange={(e) => setVoiceSettings({ serverVadThreshold: Number(e.target.value) })}
                      disabled={voice.serverVadProvider !== "energy"}
                    />
                  </label>
                  <label className="setting-field">
                    <span>Native VAD model path</span>
                    <input
                      value={voice.serverVadModelPath}
                      onChange={(e) => setVoiceSettings({ serverVadModelPath: e.target.value })}
                      placeholder="C:/models/silero_vad.onnx"
                      disabled={voice.serverVadProvider !== "native"}
                    />
                  </label>
                </div>
                {voice.serverVadProvider === "native" && (
                  <div className="settings-presets piper-presets vad-presets">
                    <span className="setting-mini-title">VAD presets</span>
                    <div className="preset-grid">
                      {VAD_PRESETS.map((preset) => (
                        <div className="preset-card" key={preset.id}>
                          <a href={preset.modelUrl} target="_blank" rel="noreferrer">
                            <span>{preset.name}</span>
                            <small>
                              {preset.language} - {preset.size}
                            </small>
                          </a>
                          <button
                            className="btn-ghost preset-install"
                            type="button"
                            disabled={Boolean(installingVadPreset)}
                            onClick={() => void installVad(preset)}
                          >
                            {installingVadPreset === preset.id ? "Installing" : "Install"}
                          </button>
                        </div>
                      ))}
                    </div>
                    {(vadInstallProgress || installingVadPreset) && (
                      <div className="model-progress piper-install-progress vad-install-progress">
                        {vadInstallProgress?.done ? (
                          <span className="model-ok">Installed {vadInstallProgress.id}</span>
                        ) : (
                          <>
                            <div className="progress-track">
                              <div
                                className={"progress-fill" + (vadInstallPct == null ? " indeterminate" : "")}
                                style={{ width: vadInstallPct != null ? `${vadInstallPct}%` : "40%" }}
                              />
                            </div>
                            <span className="progress-label">
                              Model
                              {vadInstallProgress?.downloaded != null ? ` ${fmtBytes(vadInstallProgress.downloaded)}` : ""}
                              {vadInstallProgress?.total ? ` / ${fmtBytes(vadInstallProgress.total)}` : ""}
                              {vadInstallPct != null ? ` (${vadInstallPct}%)` : " ..."}
                            </span>
                            {installingVadPreset && (
                              <button className="btn-ghost" type="button" onClick={cancelVadInstall}>
                                Cancel
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="voice-test-row">
                  {voice.serverVadProvider === "native" && (
                    <button
                      className="btn-ghost"
                      type="button"
                      onClick={() => void runSetupCheck("vad")}
                      disabled={setupCheck.vad?.kind === "running"}
                    >
                      Check VAD
                    </button>
                  )}
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={testVadProvider}
                    disabled={Boolean(vadConfigIssue) || vadTest?.kind === "running"}
                  >
                    Test VAD
                  </button>
                  {vadConfigIssue && <span className="voice-test-status error">{vadConfigIssue}</span>}
                  {setupCheck.vad && !vadConfigIssue && (
                    <span className={`setup-check-status voice-test-status ${setupCheck.vad.kind}`} role="status">
                      {setupCheck.vad.message}
                    </span>
                  )}
                  {vadTest && !vadConfigIssue && (
                    <span className={`voice-test-status ${vadTest.kind}`} role="status">
                      {vadTest.message}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>

            </SettingsBlock>
            )}

            <SettingsBlock title="Diagnostics">
          <div className="settings-diagnostics">
          <div className="voice-test-row">
            {(voice.provider === "whisper" || voice.provider === "parakeet") && (
              <button
                className="btn-ghost"
                type="button"
                onClick={() => void runSetupCheck("stt")}
                disabled={setupCheck.stt?.kind === "running"}
              >
                Check setup
              </button>
            )}
            <button
              className="btn-ghost"
              type="button"
              onClick={testVoiceProvider}
              disabled={Boolean(voiceConfigIssue) || voiceTest?.kind === "running"}
            >
              Test transcription
            </button>
            {voiceConfigIssue && <span className="voice-test-status error">{voiceConfigIssue}</span>}
            {setupCheck.stt && !voiceConfigIssue && (
              <span className={`setup-check-status voice-test-status ${setupCheck.stt.kind}`} role="status">
                {setupCheck.stt.message}
              </span>
            )}
            {voiceTest && !voiceConfigIssue && (
              <span className={`voice-test-status ${voiceTest.kind}`} role="status">
                {voiceTest.message}
              </span>
            )}
          </div>
          </div>
            </SettingsBlock>
          </SettingsPanel>
          )}

          {audioTab === "output" && (
          <SettingsPanel>
            <SettingsBlock title="Provider">
              <div className="setting-stack">
                <div className="stt-grid tts-provider-grid">
                  {visibleTtsOptions.map((option) => (
                    <button
                      key={option.id}
                      className={"stt-card" + (voice.ttsProvider === option.id ? " active" : "")}
                      onClick={() => setVoiceSettings({ ttsProvider: option.id as TtsProvider })}
                      type="button"
                    >
                      <span className="stt-card-top">
                        <span>{option.label}</span>
                        <span className="stt-badge">{option.badge}</span>
                      </span>
                      <span className="stt-detail">{option.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
            </SettingsBlock>

            <SettingsBlock title="Setup">
              <div className="setting-stack">
            {voice.ttsProvider === "command" && (
              <label className="setting-field">
                <span>TTS command</span>
                <input
                  value={voice.ttsCommand}
                  onChange={(e) => setVoiceSettings({ ttsCommand: e.target.value })}
                  placeholder="tts-speak"
                />
              </label>
            )}
            {voice.ttsProvider === "openai" && (
              <div className="setting-stack">
                <label className="setting-field">
                  <span>OpenAI-compatible TTS endpoint</span>
                  <input
                    value={voice.ttsOpenAiEndpoint}
                    onChange={(e) => setVoiceSettings({ ttsOpenAiEndpoint: e.target.value })}
                    placeholder="https://api.openai.com/v1/audio/speech"
                  />
                </label>
                <label className="setting-field">
                  <span>Model</span>
                  <input
                    value={voice.ttsOpenAiModel}
                    onChange={(e) => setVoiceSettings({ ttsOpenAiModel: e.target.value })}
                    placeholder="gpt-4o-mini-tts"
                  />
                </label>
                <label className="setting-field">
                  <span>API key</span>
                  <input
                    value={voice.ttsOpenAiApiKey}
                    onChange={(e) => setVoiceSettings({ ttsOpenAiApiKey: e.target.value })}
                    placeholder="Optional for local compatible endpoints"
                    type="password"
                  />
                </label>
              </div>
            )}
            {voice.ttsProvider === "piper" && (
              <div className="setting-stack">
                <div className="setting-field">
                  <span>Piper command</span>
                  <div className="setting-field-action">
                    <input
                      value={voice.piperCommand}
                      onChange={(e) => setVoiceSettings({ piperCommand: e.target.value })}
                      placeholder="piper"
                    />
                    {showVoiceAdvanced && (
                      <button
                        className="btn-ghost"
                        type="button"
                        disabled={installingPiperExecutable}
                        onClick={() => void installPiperCommand()}
                      >
                        {installingPiperExecutable ? "Installing" : "Install Piper"}
                      </button>
                    )}
                  </div>
                  {showVoiceAdvanced && (executableInstallProgress || installingPiperExecutable) && (
                    <div className="model-progress piper-install-progress piper-executable-progress">
                      {executableInstallProgress?.done ? (
                        <span className="model-ok">Installed Piper</span>
                      ) : (
                        <>
                          <div className="progress-track">
                            <div
                              className={"progress-fill" + (executableInstallPct == null ? " indeterminate" : "")}
                              style={{ width: executableInstallPct != null ? `${executableInstallPct}%` : "40%" }}
                            />
                          </div>
                          <span className="progress-label">
                            {executableInstallPhaseLabel}
                            {executableInstallProgress?.downloaded != null
                              ? ` ${fmtBytes(executableInstallProgress.downloaded)}`
                              : ""}
                            {executableInstallProgress?.total ? ` / ${fmtBytes(executableInstallProgress.total)}` : ""}
                            {executableInstallPct != null ? ` (${executableInstallPct}%)` : " ..."}
                          </span>
                          {installingPiperExecutable && (
                            <button className="btn-ghost" type="button" onClick={cancelPiperExecutableInstall}>
                              Cancel
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
                <label className="setting-field">
                  <span>Piper model path</span>
                  <input
                    value={voice.piperModelPath}
                    onChange={(e) => setVoiceSettings({ piperModelPath: e.target.value })}
                    placeholder="C:/models/piper/en_US-lessac-medium.onnx"
                  />
                </label>
                {showVoiceAdvanced && (
                <div className="settings-presets piper-presets">
                  <span className="setting-mini-title">Piper presets</span>
                  <div className="preset-grid">
                    {PIPER_PRESETS.map((preset) => (
                      <div className="preset-card" key={preset.id}>
                        <a href={preset.modelUrl} target="_blank" rel="noreferrer">
                          <span>{preset.name}</span>
                          <small>
                            {preset.language} - {preset.size}
                          </small>
                        </a>
                        <button
                          className="btn-ghost preset-install"
                          type="button"
                          disabled={Boolean(installingPreset)}
                          onClick={() => void installPreset(preset)}
                        >
                          {installingPreset === preset.id ? "Installing" : "Install"}
                        </button>
                      </div>
                    ))}
                  </div>
                  {(installProgress || installingPreset) && (
                    <div className="model-progress piper-install-progress">
                      {installProgress?.done ? (
                        <span className="model-ok">Installed {installProgress.id}</span>
                      ) : (
                        <>
                          <div className="progress-track">
                            <div
                              className={"progress-fill" + (installPct == null ? " indeterminate" : "")}
                              style={{ width: installPct != null ? `${installPct}%` : "40%" }}
                            />
                          </div>
                          <span className="progress-label">
                            {installPhaseLabel}
                            {installProgress?.downloaded != null ? ` ${fmtBytes(installProgress.downloaded)}` : ""}
                            {installProgress?.total ? ` / ${fmtBytes(installProgress.total)}` : ""}
                            {installPct != null ? ` (${installPct}%)` : " ..."}
                          </span>
                          {installingPreset && (
                            <button className="btn-ghost" type="button" onClick={cancelPresetInstall}>
                              Cancel
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
                )}
              </div>
            )}
            {voice.ttsProvider === "native" && (
              <div className="setting-stack">
                <div className="setting-field">
                  <span>Native engine</span>
                  <div className="native-engine-row">
                    <button
                      className={"btn-ghost" + (voice.nativeTtsEngine === "piper" ? " active" : "")}
                      type="button"
                      onClick={() => setVoiceSettings({ nativeTtsEngine: "piper" })}
                    >
                      Piper ONNX
                    </button>
                    <button
                      className={"btn-ghost" + (voice.nativeTtsEngine === "kokoro" ? " active" : "")}
                      type="button"
                      onClick={() => setVoiceSettings({ nativeTtsEngine: "kokoro" })}
                    >
                      Kokoro
                    </button>
                  </div>
                </div>
                <label className="setting-field">
                  <span>Native TTS model path</span>
                  <input
                    value={voice.nativeTtsModelPath}
                    onChange={(e) => setVoiceSettings({ nativeTtsModelPath: e.target.value })}
                    placeholder="C:/models/tts/model.onnx"
                  />
                </label>
                <label className="setting-field">
                  <span>Native TTS config path</span>
                  <input
                    value={voice.nativeTtsConfigPath}
                    onChange={(e) => setVoiceSettings({ nativeTtsConfigPath: e.target.value })}
                    placeholder="Optional config, tokenizer, or voices file"
                  />
                </label>
                {showVoiceAdvanced && voice.nativeTtsEngine === "kokoro" && (
                  <div className="settings-presets piper-presets kokoro-presets">
                    <span className="setting-mini-title">Kokoro presets</span>
                    <div className="preset-grid">
                      {KOKORO_PRESETS.map((preset) => (
                        <div className="preset-card" key={preset.id}>
                          <a href={preset.modelUrl} target="_blank" rel="noreferrer">
                            <span>{preset.name}</span>
                            <small>
                              {preset.language} - {preset.voice} - {preset.size}
                            </small>
                          </a>
                          <button
                            className="btn-ghost preset-install"
                            type="button"
                            disabled={Boolean(installingKokoroPreset)}
                            onClick={() => void installKokoro(preset)}
                          >
                            {installingKokoroPreset === preset.id ? "Installing" : "Install"}
                          </button>
                        </div>
                      ))}
                    </div>
                    {(kokoroInstallProgress || installingKokoroPreset) && (
                      <div className="model-progress piper-install-progress kokoro-install-progress">
                        {kokoroInstallProgress?.done ? (
                          <span className="model-ok">Installed {kokoroInstallProgress.id}</span>
                        ) : (
                          <>
                            <div className="progress-track">
                              <div
                                className={"progress-fill" + (kokoroInstallPct == null ? " indeterminate" : "")}
                                style={{ width: kokoroInstallPct != null ? `${kokoroInstallPct}%` : "40%" }}
                              />
                            </div>
                            <span className="progress-label">
                              {kokoroInstallPhaseLabel}
                              {kokoroInstallProgress?.downloaded != null ? ` ${fmtBytes(kokoroInstallProgress.downloaded)}` : ""}
                              {kokoroInstallProgress?.total ? ` / ${fmtBytes(kokoroInstallProgress.total)}` : ""}
                              {kokoroInstallPct != null ? ` (${kokoroInstallPct}%)` : " ..."}
                            </span>
                            {installingKokoroPreset && (
                              <button className="btn-ghost" type="button" onClick={cancelKokoroInstall}>
                                Cancel
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="setting-field-row setting-field-pair">
              <label className="setting-field">
                <span>Voice</span>
                <input
                  value={voice.ttsVoice}
                  onChange={(e) => setVoiceSettings({ ttsVoice: e.target.value })}
                  placeholder="alloy"
                />
              </label>
              <label className="setting-field">
                <span>Speed</span>
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={voice.ttsSpeed}
                  onChange={(e) => setVoiceSettings({ ttsSpeed: Number(e.target.value) })}
                />
              </label>
            </div>
          </div>
          <details className="settings-contract">
            <summary>Provider contract</summary>
            <p>
              {voice.ttsProvider === "piper" ? (
                <>
                  Milim runs Piper as <code>{"--model <model> --output_file <wav> --speaker <voice> --length_scale <scale>"}</code> and sends text on stdin.
                </>
              ) : voice.ttsProvider === "openai" ? (
                <>
                  OpenAI-compatible TTS sends JSON to <code>{"/audio/speech"}</code> with model, input, voice, speed, and WAV output requested.
                </>
              ) : voice.ttsProvider === "native" ? (
                <>
                  Native ORT uses <code>{voice.nativeTtsEngine === "kokoro" ? "Kokoro" : "Piper ONNX"}</code> models when built with <code>native-tts</code>. English eSpeak paths need <code>native-tts-espeak</code>.
                </>
              ) : (
                <>
                  Milim runs the command as <code>{"--text <text> --voice <voice> --speed <speed>"}</code>. Return WAV bytes on stdout.
                </>
              )}
            </p>
          </details>
            </SettingsBlock>

            <SettingsBlock title="Diagnostics">
          <div className="settings-diagnostics">
          <div className="voice-test-row">
            <button
              className="btn-ghost"
              type="button"
              onClick={() => void runSetupCheck("tts")}
              disabled={!voice.ttsEnabled || setupCheck.tts?.kind === "running"}
            >
              Check setup
            </button>
            <button
              className="btn-ghost"
              type="button"
              onClick={testTtsPlayback}
              disabled={!voice.ttsEnabled || Boolean(ttsConfigIssue) || ttsTest?.kind === "running"}
            >
              Test voice
            </button>
            {ttsConfigIssue && <span className="tts-test-status voice-test-status error">{ttsConfigIssue}</span>}
            {setupCheck.tts && !ttsConfigIssue && (
              <span className={`setup-check-status voice-test-status ${setupCheck.tts.kind}`} role="status">
                {setupCheck.tts.message}
              </span>
            )}
            {ttsTest && !ttsConfigIssue && (
              <span className={`tts-test-status voice-test-status ${ttsTest.kind}`} role="status">
                {ttsTest.message}
              </span>
            )}
          </div>
          </div>
            </SettingsBlock>
          </SettingsPanel>
          )}
        </section>
            )}

            {activeSection === "appearance" && (
        <section className="settings-section" id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Theme">
              <div className="theme-grid">
                {themes.map((t) => (
                  <button
                    key={t.id}
                    className={"theme-card" + (t.id === themeId ? " active" : "")}
                    onClick={() => setTheme(t.id)}
                    onDoubleClick={() => customIds.has(t.id) && setEditing({ base: t, isNew: false })}
                    title={customIds.has(t.id) ? "Double-click to edit" : undefined}
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
                ))}

                <button className="theme-card new-card" onClick={() => setEditing({ base: current, isNew: true })}>
                  <span className="theme-preview new">
                    <PlusSquare size={22} />
                  </span>
                  <span className="theme-name">Customize...</span>
                </button>
              </div>

              {custom.length > 0 && <p className="sheet-hint">Double-click a custom theme to edit or delete it.</p>}
            </SettingsBlock>
            <SettingsBlock title="Chat surface">
              <div className="setting-stack">
                <div className="setting-field">
                  <span className="setting-mini-title">Layout</span>
                  <SettingsChoiceGroup<ChatLayoutStyle>
                    value={chatLayoutStyle}
                    onChange={setChatLayoutStyle}
                    testIdPrefix="appearance-chat-layout"
                    options={[
                      { value: "transcript", label: "Transcript", detail: "Assistant text stays open and flat." },
                      { value: "bubbles", label: "Bubbles", detail: "Both sides render as message bubbles." },
                      { value: "compact", label: "Compact log", detail: "Tighter spacing for long sessions." },
                    ]}
                  />
                </div>
                <div className="setting-field">
                  <span className="setting-mini-title">Message width</span>
                  <SettingsChoiceGroup<MessageWidth>
                    value={messageWidth}
                    onChange={setMessageWidth}
                    testIdPrefix="appearance-message-width"
                    options={[
                      { value: "standard", label: "Standard", detail: "Current reading width." },
                      { value: "narrow", label: "Narrow", detail: "Shorter line length." },
                      { value: "wide", label: "Wide", detail: "More horizontal room." },
                      { value: "full", label: "Full", detail: "Use the full chat pane." },
                    ]}
                  />
                </div>
                <div className="setting-field">
                  <span className="setting-mini-title">Avatars</span>
                  <SettingsChoiceGroup<AvatarStyle>
                    value={avatarStyle}
                    onChange={setAvatarStyle}
                    testIdPrefix="appearance-avatar-style"
                    options={[
                      { value: "none", label: "None", detail: "Keep the current clean transcript." },
                      { value: "initials", label: "Initials", detail: "Small role marks beside messages." },
                      { value: "role", label: "Role labels", detail: "Text labels for sender scanning." },
                    ]}
                  />
                </div>
              </div>
            </SettingsBlock>
            <SettingsBlock title="Code blocks">
              <SettingsChoiceGroup<CodeBlockTheme>
                value={codeBlockTheme}
                onChange={setCodeBlockTheme}
                testIdPrefix="appearance-code-theme"
                options={[
                  { value: "match", label: "Match app", detail: "Use the active theme colors." },
                  { value: "terminal", label: "Terminal", detail: "Dark console-style contrast." },
                  { value: "github", label: "GitHub", detail: "Light editor-style blocks." },
                  { value: "high-contrast", label: "High contrast", detail: "Maximum code legibility." },
                ]}
              />
            </SettingsBlock>
            <SettingsBlock title="Background image">
              <div className="setting-stack">
                <div className="setting-field">
                  <span className="setting-mini-title">Fit</span>
                  <SettingsChoiceGroup<BackgroundFit>
                    value={backgroundFit}
                    onChange={setBackgroundFit}
                    testIdPrefix="appearance-background-fit"
                    options={[
                      { value: "cover", label: "Cover", detail: "Fill the window." },
                      { value: "contain", label: "Contain", detail: "Show the whole image." },
                      { value: "center", label: "Center", detail: "Original size, centered." },
                      { value: "tile", label: "Tile", detail: "Repeat as a pattern." },
                    ]}
                  />
                </div>
                <div className="setting-field">
                  <span className="setting-mini-title">Treatment</span>
                  <SettingsChoiceGroup<BackgroundTreatment>
                    value={backgroundTreatment}
                    onChange={setBackgroundTreatment}
                    testIdPrefix="appearance-background-treatment"
                    options={[
                      { value: "clear", label: "Clear", detail: "Use the theme image as-is." },
                      { value: "dim", label: "Dim", detail: "Darken for calmer contrast." },
                      { value: "blur", label: "Blur", detail: "Soften busy images." },
                      { value: "mono", label: "Mono", detail: "Desaturate the image." },
                    ]}
                  />
                </div>
              </div>
            </SettingsBlock>
          </SettingsPanel>
        </section>
            )}

            {activeSection === "system" && (
        <section className="settings-section" id="settings-panel-system" role="tabpanel" aria-labelledby="settings-tab-system" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Keyboard shortcuts">
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
            <SettingsBlock title="Mobile companion">
              <MobileCompanionSettings />
            </SettingsBlock>
          </SettingsPanel>
        </section>
            )}

            {activeSection === "about" && (
        <section className="settings-section" id="settings-panel-about" role="tabpanel" aria-labelledby="settings-tab-about" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Version">
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

            <SettingsBlock title="Updates">
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
          </SettingsPanel>
        </section>
            )}

            {activeSection === "developer" && (
        <section className="settings-section" id="settings-panel-developer" role="tabpanel" aria-labelledby="settings-tab-developer" tabIndex={-1}>
          <SettingsPanel>
            <SettingsBlock title="Mode">
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
                      {onboardingStatus} / {onboardingMode ?? "no mode"} / {onboardingSetupLabel(onboardingSetupPath)}
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
