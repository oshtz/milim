import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { userStateStorage, writeUserStateKey } from "../persistence/userStateStorage.js";
import {
  DEFAULT_APP_SHORTCUTS,
  normalizeAppShortcuts,
  normalizeShortcut,
  shortcutConflict,
  shortcutValidationIssue,
  type AppShortcutAction,
  type AppShortcuts,
} from "./shortcuts.js";

export type ComposerSendShortcut = "enter" | "modEnter";
export type ComposerDensity = "comfortable" | "compact";
export type InterfaceMode = "simple" | "workbench";
export type ChatLayoutStyle = "transcript" | "bubbles" | "compact";
export type MessageWidth = "narrow" | "standard" | "wide" | "full";
export type AvatarStyle = "none" | "initials" | "role";
export type CodeBlockTheme = "match" | "terminal" | "github" | "high-contrast";
export type BackgroundFit = "cover" | "contain" | "tile" | "center";
export type BackgroundTreatment = "clear" | "dim" | "blur" | "mono";
export type AppNoticeTone = "info" | "success" | "warning" | "error";

export interface AppNotice {
  id: string;
  tone: AppNoticeTone;
  message: string;
  createdAt: number;
}

const WINDOW_ALWAYS_ON_TOP_KEY = "milim.window.alwaysOnTop";

interface UiPreferencesState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  previewPanelWidth: number;
  uiSize: number;
  windowAlwaysOnTop: boolean;
  composerSendShortcut: ComposerSendShortcut;
  composerDensity: ComposerDensity;
  autoTitleChats: boolean;
  aiThreadNames: boolean;
  aiThreadNameModel: string;
  newChatButtonAtBottom: boolean;
  interfaceMode: InterfaceMode;
  developerMode: boolean;
  experimentalHashlinePatch: boolean;
  chatLayoutStyle: ChatLayoutStyle;
  messageWidth: MessageWidth;
  avatarStyle: AvatarStyle;
  codeBlockTheme: CodeBlockTheme;
  backgroundFit: BackgroundFit;
  backgroundTreatment: BackgroundTreatment;
  gitPanelExpanded: boolean;
  notices: AppNotice[];
  appShortcuts: AppShortcuts;
  setSidebarOpen: (sidebarOpen: boolean) => void;
  setSidebarWidth: (sidebarWidth: number) => void;
  setPreviewPanelWidth: (previewPanelWidth: number) => void;
  setUiSize: (uiSize: number) => void;
  setWindowAlwaysOnTop: (windowAlwaysOnTop: boolean) => void;
  setComposerSendShortcut: (composerSendShortcut: ComposerSendShortcut) => void;
  setComposerDensity: (composerDensity: ComposerDensity) => void;
  setAutoTitleChats: (autoTitleChats: boolean) => void;
  setAiThreadNames: (aiThreadNames: boolean) => void;
  setAiThreadNameModel: (aiThreadNameModel: string) => void;
  setNewChatButtonAtBottom: (newChatButtonAtBottom: boolean) => void;
  setInterfaceMode: (interfaceMode: InterfaceMode) => void;
  setDeveloperMode: (developerMode: boolean) => void;
  setExperimentalHashlinePatch: (experimentalHashlinePatch: boolean) => void;
  setChatLayoutStyle: (chatLayoutStyle: ChatLayoutStyle) => void;
  setMessageWidth: (messageWidth: MessageWidth) => void;
  setAvatarStyle: (avatarStyle: AvatarStyle) => void;
  setCodeBlockTheme: (codeBlockTheme: CodeBlockTheme) => void;
  setBackgroundFit: (backgroundFit: BackgroundFit) => void;
  setBackgroundTreatment: (backgroundTreatment: BackgroundTreatment) => void;
  setGitPanelExpanded: (gitPanelExpanded: boolean) => void;
  pushNotice: (notice: { tone: AppNoticeTone; message: string }) => string;
  dismissNotice: (id: string) => void;
  setAppShortcut: (action: AppShortcutAction, shortcut: string) => boolean;
  resetAppShortcuts: () => void;
  resetLayoutWidths: () => void;
  toggleSidebar: () => void;
}

export const DEFAULT_SIDEBAR_WIDTH = 248;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 420;
export const DEFAULT_PREVIEW_PANEL_WIDTH = 420;
const MIN_PREVIEW_PANEL_WIDTH = 280;
const MAX_PREVIEW_PANEL_WIDTH = 900;
export const DEFAULT_UI_SIZE = 100;
export const MIN_UI_SIZE = 80;
export const MAX_UI_SIZE = 140;
export const UI_SIZE_STEP = 10;

export function normalizeSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH));
}

function normalizePreviewPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PREVIEW_PANEL_WIDTH;
  return Math.round(Math.min(Math.max(width, MIN_PREVIEW_PANEL_WIDTH), MAX_PREVIEW_PANEL_WIDTH));
}

export function normalizeUiSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_UI_SIZE;
  const stepped = Math.round(size / UI_SIZE_STEP) * UI_SIZE_STEP;
  return Math.min(Math.max(stepped, MIN_UI_SIZE), MAX_UI_SIZE);
}

function normalizeComposerSendShortcut(value: unknown): ComposerSendShortcut {
  return value === "modEnter" ? "modEnter" : "enter";
}

function normalizeComposerDensity(value: unknown): ComposerDensity {
  return value === "compact" ? "compact" : "comfortable";
}

function normalizeAiThreadNameModel(value: unknown): string {
  return typeof value === "string" && value.trim().toLowerCase() !== "mock-echo" ? value.trim() : "";
}

function normalizeInterfaceMode(value: unknown): InterfaceMode {
  return value === "workbench" ? "workbench" : "simple";
}

function normalizeChatLayoutStyle(value: unknown): ChatLayoutStyle {
  return value === "bubbles" || value === "compact" ? value : "transcript";
}

function normalizeMessageWidth(value: unknown): MessageWidth {
  return value === "narrow" || value === "wide" || value === "full" ? value : "standard";
}

function normalizeAvatarStyle(value: unknown): AvatarStyle {
  return value === "initials" || value === "role" ? value : "none";
}

function normalizeCodeBlockTheme(value: unknown): CodeBlockTheme {
  return value === "terminal" || value === "github" || value === "high-contrast" ? value : "match";
}

function normalizeBackgroundFit(value: unknown): BackgroundFit {
  return value === "contain" || value === "tile" || value === "center" ? value : "cover";
}

function normalizeBackgroundTreatment(value: unknown): BackgroundTreatment {
  return value === "dim" || value === "blur" || value === "mono" ? value : "clear";
}

function persistWindowAlwaysOnTop(windowAlwaysOnTop: boolean): void {
  void Promise.resolve(writeUserStateKey(WINDOW_ALWAYS_ON_TOP_KEY, String(windowAlwaysOnTop))).catch(() => {});
}

export const useUiPreferences = create<UiPreferencesState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      previewPanelWidth: DEFAULT_PREVIEW_PANEL_WIDTH,
      uiSize: DEFAULT_UI_SIZE,
      windowAlwaysOnTop: false,
      composerSendShortcut: "enter",
      composerDensity: "comfortable",
      autoTitleChats: true,
      aiThreadNames: false,
      aiThreadNameModel: "",
      newChatButtonAtBottom: false,
      interfaceMode: "simple",
      developerMode: false,
      experimentalHashlinePatch: false,
      chatLayoutStyle: "transcript",
      messageWidth: "standard",
      avatarStyle: "none",
      codeBlockTheme: "match",
      backgroundFit: "cover",
      backgroundTreatment: "clear",
      gitPanelExpanded: false,
      notices: [],
      appShortcuts: { ...DEFAULT_APP_SHORTCUTS },
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: normalizeSidebarWidth(sidebarWidth) }),
      setPreviewPanelWidth: (previewPanelWidth) => set({ previewPanelWidth: normalizePreviewPanelWidth(previewPanelWidth) }),
      setUiSize: (uiSize) => set({ uiSize: normalizeUiSize(uiSize) }),
      setWindowAlwaysOnTop: (windowAlwaysOnTop) => {
        persistWindowAlwaysOnTop(windowAlwaysOnTop);
        set({ windowAlwaysOnTop });
      },
      setComposerSendShortcut: (composerSendShortcut) =>
        set({ composerSendShortcut: normalizeComposerSendShortcut(composerSendShortcut) }),
      setComposerDensity: (composerDensity) => set({ composerDensity: normalizeComposerDensity(composerDensity) }),
      setAutoTitleChats: (autoTitleChats) => set({ autoTitleChats }),
      setAiThreadNames: (aiThreadNames) => set({ aiThreadNames }),
      setAiThreadNameModel: (aiThreadNameModel) => set({ aiThreadNameModel: normalizeAiThreadNameModel(aiThreadNameModel) }),
      setNewChatButtonAtBottom: (newChatButtonAtBottom) => set({ newChatButtonAtBottom }),
      setInterfaceMode: (interfaceMode) => set({ interfaceMode: normalizeInterfaceMode(interfaceMode) }),
      setDeveloperMode: (developerMode) => set({ developerMode }),
      setExperimentalHashlinePatch: (experimentalHashlinePatch) => set({ experimentalHashlinePatch }),
      setChatLayoutStyle: (chatLayoutStyle) => set({ chatLayoutStyle: normalizeChatLayoutStyle(chatLayoutStyle) }),
      setMessageWidth: (messageWidth) => set({ messageWidth: normalizeMessageWidth(messageWidth) }),
      setAvatarStyle: (avatarStyle) => set({ avatarStyle: normalizeAvatarStyle(avatarStyle) }),
      setCodeBlockTheme: (codeBlockTheme) => set({ codeBlockTheme: normalizeCodeBlockTheme(codeBlockTheme) }),
      setBackgroundFit: (backgroundFit) => set({ backgroundFit: normalizeBackgroundFit(backgroundFit) }),
      setBackgroundTreatment: (backgroundTreatment) => set({ backgroundTreatment: normalizeBackgroundTreatment(backgroundTreatment) }),
      setGitPanelExpanded: (gitPanelExpanded) => set({ gitPanelExpanded }),
      pushNotice: (notice) => {
        const id = `notice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        set((state) => ({
          notices: [
            ...state.notices.slice(-3),
            { ...notice, id, createdAt: Date.now() },
          ],
        }));
        return id;
      },
      dismissNotice: (id) =>
        set((state) => ({
          notices: state.notices.filter((notice) => notice.id !== id),
        })),
      setAppShortcut: (action, shortcut) => {
        let accepted = false;
        set((state) => {
          const normalized = normalizeShortcut(shortcut);
          const current = normalizeAppShortcuts(state.appShortcuts);
          if (
            !normalized ||
            shortcutValidationIssue(normalized) ||
            shortcutConflict(current, action, normalized)
          ) {
            return {};
          }
          accepted = true;
          return { appShortcuts: { ...current, [action]: normalized } };
        });
        return accepted;
      },
      resetAppShortcuts: () => set({ appShortcuts: { ...DEFAULT_APP_SHORTCUTS } }),
      resetLayoutWidths: () =>
        set({
          sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
          previewPanelWidth: DEFAULT_PREVIEW_PANEL_WIDTH,
        }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
    }),
    {
      name: "milim.ui",
      storage: createJSONStorage(() => userStateStorage),
      merge: (persisted, current) => {
        const saved = persisted as (Partial<UiPreferencesState> & { thinkingBlocksOpen?: unknown }) | undefined;
        const savedState = saved ? { ...saved } : undefined;
        delete savedState?.thinkingBlocksOpen;
        return {
          ...current,
          ...savedState,
          sidebarOpen: typeof saved?.sidebarOpen === "boolean" ? saved.sidebarOpen : current.sidebarOpen,
          sidebarWidth: normalizeSidebarWidth(saved?.sidebarWidth ?? current.sidebarWidth),
          previewPanelWidth: normalizePreviewPanelWidth(saved?.previewPanelWidth ?? current.previewPanelWidth),
          uiSize: normalizeUiSize(saved?.uiSize ?? current.uiSize),
          windowAlwaysOnTop: typeof saved?.windowAlwaysOnTop === "boolean" ? saved.windowAlwaysOnTop : current.windowAlwaysOnTop,
          composerSendShortcut: normalizeComposerSendShortcut(saved?.composerSendShortcut),
          composerDensity: normalizeComposerDensity(saved?.composerDensity),
          autoTitleChats: typeof saved?.autoTitleChats === "boolean" ? saved.autoTitleChats : current.autoTitleChats,
          aiThreadNames: typeof saved?.aiThreadNames === "boolean" ? saved.aiThreadNames : current.aiThreadNames,
          aiThreadNameModel: normalizeAiThreadNameModel(saved?.aiThreadNameModel),
          newChatButtonAtBottom: typeof saved?.newChatButtonAtBottom === "boolean" ? saved.newChatButtonAtBottom : current.newChatButtonAtBottom,
          interfaceMode: normalizeInterfaceMode(saved?.interfaceMode),
          developerMode: typeof saved?.developerMode === "boolean" ? saved.developerMode : current.developerMode,
          experimentalHashlinePatch: typeof saved?.experimentalHashlinePatch === "boolean" ? saved.experimentalHashlinePatch : current.experimentalHashlinePatch,
          chatLayoutStyle: normalizeChatLayoutStyle(saved?.chatLayoutStyle),
          messageWidth: normalizeMessageWidth(saved?.messageWidth),
          avatarStyle: normalizeAvatarStyle(saved?.avatarStyle),
          codeBlockTheme: normalizeCodeBlockTheme(saved?.codeBlockTheme),
          backgroundFit: normalizeBackgroundFit(saved?.backgroundFit),
          backgroundTreatment: normalizeBackgroundTreatment(saved?.backgroundTreatment),
          gitPanelExpanded: typeof saved?.gitPanelExpanded === "boolean" ? saved.gitPanelExpanded : current.gitPanelExpanded,
          notices: [],
          appShortcuts: normalizeAppShortcuts(saved?.appShortcuts),
        };
      },
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: normalizeSidebarWidth(state.sidebarWidth),
        previewPanelWidth: normalizePreviewPanelWidth(state.previewPanelWidth),
        uiSize: normalizeUiSize(state.uiSize),
        windowAlwaysOnTop: state.windowAlwaysOnTop,
        composerSendShortcut: normalizeComposerSendShortcut(state.composerSendShortcut),
        composerDensity: normalizeComposerDensity(state.composerDensity),
        autoTitleChats: state.autoTitleChats,
        aiThreadNames: state.aiThreadNames,
        aiThreadNameModel: normalizeAiThreadNameModel(state.aiThreadNameModel),
        newChatButtonAtBottom: state.newChatButtonAtBottom,
        interfaceMode: normalizeInterfaceMode(state.interfaceMode),
        developerMode: state.developerMode,
        experimentalHashlinePatch: state.experimentalHashlinePatch,
        chatLayoutStyle: normalizeChatLayoutStyle(state.chatLayoutStyle),
        messageWidth: normalizeMessageWidth(state.messageWidth),
        avatarStyle: normalizeAvatarStyle(state.avatarStyle),
        codeBlockTheme: normalizeCodeBlockTheme(state.codeBlockTheme),
        backgroundFit: normalizeBackgroundFit(state.backgroundFit),
        backgroundTreatment: normalizeBackgroundTreatment(state.backgroundTreatment),
        gitPanelExpanded: state.gitPanelExpanded,
        appShortcuts: normalizeAppShortcuts(state.appShortcuts),
      }),
    },
  ),
);
