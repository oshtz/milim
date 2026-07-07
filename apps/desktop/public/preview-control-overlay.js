const STORAGE_PREFIX = "milim-preview-control-activity:";
const POINT_PREFIX = "milim-preview-control-point:";
const HOLD_MS = 2600;
const params = new URLSearchParams(location.search);
const channel = params.get("channel") || "preview-control-overlay";
const storageKey = `${STORAGE_PREFIX}${channel}`;
const pointKey = `${POINT_PREFIX}${channel}`;
const root = document.documentElement;
const overlay = document.getElementById("overlay");
const labelEl = document.getElementById("label");
const glowEl = document.getElementById("glow");
const cursorEl = document.getElementById("cursor");
const ringEl = document.getElementById("ring");
const scrollEl = document.getElementById("scroll");
const caretEl = document.getElementById("caret");
const gestures = ["move", "click", "scroll", "type", "inspect"];
const statuses = ["running", "done", "error"];
const points = {
  move: [{ x: 72, y: 34 }, { x: 28, y: 62 }, { x: 66, y: 70 }, { x: 38, y: 38 }],
  click: [{ x: 62, y: 46 }, { x: 30, y: 54 }, { x: 68, y: 68 }, { x: 42, y: 34 }],
  scroll: [{ x: 66, y: 38 }, { x: 52, y: 66 }, { x: 74, y: 52 }],
  type: [{ x: 36, y: 66 }, { x: 58, y: 60 }, { x: 44, y: 42 }],
  inspect: [{ x: 50, y: 48 }],
};
let currentPoint = readPoint();
let hideTimer = 0;
let broadcast = null;

function readPoint() {
  try {
    const value = JSON.parse(localStorage.getItem(pointKey) || "null");
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return value;
  } catch {}
  return { x: 16, y: 68 };
}

function writePoint(point) {
  try {
    localStorage.setItem(pointKey, JSON.stringify(point));
  } catch {}
}

function hash(value) {
  let result = 0;
  for (let i = 0; i < value.length; i += 1) result = ((result << 5) - result + value.charCodeAt(i)) | 0;
  return Math.abs(result);
}

function targetPoint(activity) {
  if (activity.point) return activity.point;
  const candidates = points[activity.gesture] || points.inspect;
  return candidates[hash(activity.id || activity.label || activity.gesture) % candidates.length];
}

function normalizeActivity(value) {
  if (!value || typeof value !== "object") return null;
  const gesture = gestures.includes(value.gesture) ? value.gesture : "inspect";
  const status = statuses.includes(value.status) ? value.status : "done";
  return {
    id: String(value.id || `${gesture}:${Date.now()}`),
    gesture,
    status,
    label: String(value.label || "Preview activity"),
    dark: value.dark === true,
    accent: stringOrNull(value.accent),
    accentLight: stringOrNull(value.accentLight),
    accentGlow: stringOrNull(value.accentGlow),
    focusBorder: stringOrNull(value.focusBorder),
    point: normalizePoint(value.point),
  };
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePoint(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clampPercent(x), y: clampPercent(y) };
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

function applyTheme(activity) {
  document.body.classList.toggle("dark", activity.dark);
  if (activity.accent) root.style.setProperty("--accent", activity.accent);
  if (activity.accentLight) root.style.setProperty("--accent-light", activity.accentLight);
  if (activity.accentGlow) root.style.setProperty("--accent-glow", activity.accentGlow);
  if (activity.focusBorder) root.style.setProperty("--focus-border", activity.focusBorder);
}

function setGestureMarkup(activity) {
  const inspect = activity.gesture === "inspect";
  glowEl.hidden = inspect;
  cursorEl.hidden = inspect;
  ringEl.hidden = activity.gesture !== "click";
  scrollEl.hidden = activity.gesture !== "scroll";
  caretEl.hidden = activity.gesture !== "type";
  labelEl.textContent = activity.label;
}

function showActivity(raw) {
  const activity = normalizeActivity(raw);
  if (!activity) return;
  const nextPoint = targetPoint(activity);
  root.style.setProperty("--from-x", String(currentPoint.x));
  root.style.setProperty("--from-y", String(currentPoint.y));
  root.style.setProperty("--to-x", String(nextPoint.x));
  root.style.setProperty("--to-y", String(nextPoint.y));
  currentPoint = nextPoint;
  writePoint(nextPoint);
  applyTheme(activity);
  setGestureMarkup(activity);
  overlay.classList.remove("move", "click", "scroll", "type", "inspect", "running", "done", "error", "pulse");
  void overlay.offsetWidth;
  overlay.classList.add(activity.gesture, activity.status, "pulse", "visible");
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => overlay.classList.remove("visible"), HOLD_MS);
}

function readStoredActivity() {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || "null");
  } catch {
    return null;
  }
}

function readQueryActivity() {
  const gesture = params.get("gesture");
  if (!gestures.includes(gesture)) return null;
  return {
    id: `query:${gesture}:${params.get("label") || ""}`,
    gesture,
    status: params.get("status") || "done",
    label: params.get("label") || "Preview activity",
    dark: params.get("dark") === "true",
    accent: params.get("accent"),
    accentLight: params.get("accent-light"),
    accentGlow: params.get("accent-glow"),
    focusBorder: params.get("focus-border"),
  };
}

window.addEventListener("storage", (event) => {
  if (event.key !== storageKey || !event.newValue) return;
  try {
    showActivity(JSON.parse(event.newValue));
  } catch {}
});

if ("BroadcastChannel" in window) {
  broadcast = new BroadcastChannel(channel);
  broadcast.onmessage = (event) => showActivity(event.data);
}

window.addEventListener("pagehide", () => {
  if (broadcast) broadcast.close();
});

const initialActivity = readStoredActivity() || readQueryActivity();
if (initialActivity) {
  requestAnimationFrame(() => requestAnimationFrame(() => showActivity(initialActivity)));
}
