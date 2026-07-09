import type { WorkspaceLauncher, WorkspaceLauncherId } from "../src/api.js";

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const {
  recommendWorkspaceLauncher,
  rankedWorkspaceLaunchers,
  rememberWorkspaceLauncherInHistory,
} = await import("../src/lib/workspaceLauncher.js");

const launchers: WorkspaceLauncher[] = [
  { id: "vscode", label: "VS Code", available: true },
  { id: "zed", label: "Zed", available: true },
  { id: "file_manager", label: "File Explorer", available: true },
  { id: "terminal", label: "Terminal", available: true },
  { id: "git_bash", label: "Git Bash", available: false, reason: "Not found" },
  { id: "wsl", label: "WSL", available: false, reason: "Not found" },
  { id: "android_studio", label: "Android Studio", available: false, reason: "Not found" },
];

equal(
  recommendWorkspaceLauncher(launchers, "C:\\repo", { "C:\\repo": "zed" })?.id,
  "zed",
  "available last-used launcher should be recommended",
);

equal(
  recommendWorkspaceLauncher(launchers, "C:\\repo", { "C:\\repo": "git_bash" })?.id,
  "vscode",
  "unavailable last-used launcher should be ignored",
);

equal(
  recommendWorkspaceLauncher(
    launchers.map((launcher) =>
      launcher.id === "zed"
        ? { ...launcher, recommendedReason: "Workspace has .zed settings" }
        : launcher,
    ),
    "C:\\repo",
    {},
  )?.id,
  "zed",
  ".zed workspace marker should recommend Zed",
);

equal(
  recommendWorkspaceLauncher(
    launchers.map((launcher) =>
      launcher.id === "vscode"
        ? { ...launcher, recommendedReason: "Workspace has .vscode settings" }
        : launcher,
    ),
    "C:\\repo",
    {},
  )?.id,
  "vscode",
  ".vscode workspace marker should recommend VS Code",
);

const ranked = rankedWorkspaceLaunchers(launchers, "C:\\repo", { "C:\\repo": "terminal" });
equal(ranked[0]?.id, "terminal", "recommended launcher should sort first");
equal(
  ranked[0]?.recommendedReason,
  "Last used here",
  "last-used recommendation should explain why it is first",
);

let history: Record<string, WorkspaceLauncherId> = {};
for (let index = 0; index < 30; index += 1) {
  history = rememberWorkspaceLauncherInHistory(
    history,
    `C:\\workspace-${index}`,
    "vscode",
  );
}
equal(Object.keys(history).length, 25, "launcher history should be bounded");
equal(history["C:\\workspace-0"], undefined, "oldest launcher history entry should be dropped");
equal(history["C:\\workspace-29"], "vscode", "newest launcher history entry should be kept");

history = rememberWorkspaceLauncherInHistory(history, "C:\\workspace-10", "zed");
equal(history["C:\\workspace-10"], "zed", "remembering a folder should update its launcher");
equal(
  Object.keys(history).at(-1),
  "C:\\workspace-10",
  "updated launcher history entry should move to the newest slot",
);

export {};
