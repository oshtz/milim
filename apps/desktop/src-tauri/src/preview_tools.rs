use std::sync::{mpsc, Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use milim_core::{Error, Result};
use milim_tools::Tool;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Wry};

const PREVIEW_EVAL_TIMEOUT: Duration = Duration::from_secs(3);

const PREVIEW_ACTION_JS: &str = r#"
try {
  const rootWindow = window;
  const rootDocument = document;
  const frame = __milimNative ? null : rootDocument.querySelector(".preview-frame");
  const W = __milimNative ? rootWindow : frame?.contentWindow;
  const D = __milimNative ? rootDocument : frame?.contentDocument;
  if (!W || !D) return { ok: false, error: "No active preview document is available." };

  const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || el?.value || "").trim();
  const describe = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName?.toLowerCase?.() || "",
      text: textOf(el).slice(0, 160),
      id: el.id || null,
      testid: el.getAttribute?.("data-testid") || null,
      role: el.getAttribute?.("role") || null,
      aria: el.getAttribute?.("aria-label") || null,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  };
  const point = () => {
    let x = Number(__milimArgs.x ?? __milimArgs.client_x ?? 0);
    let y = Number(__milimArgs.y ?? __milimArgs.client_y ?? 0);
    if (x > 0 && x <= 1) x *= W.innerWidth;
    if (y > 0 && y <= 1) y *= W.innerHeight;
    return { x, y };
  };
  const byText = (text) => {
    if (!text) return null;
    const needle = String(text).toLowerCase();
    return Array.from(D.querySelectorAll("button,a,input,textarea,select,label,[role],[aria-label],[data-testid],[onclick]"))
      .find((el) => textOf(el).toLowerCase().includes(needle)) || null;
  };
  const pick = () => {
    if (__milimArgs.selector) return D.querySelector(String(__milimArgs.selector));
    if (__milimArgs.text) return byText(__milimArgs.text);
    const p = point();
    return D.elementFromPoint(p.x, p.y);
  };
  const mouse = (el, kind) => {
    const rect = el.getBoundingClientRect();
    const p = __milimArgs.x != null && __milimArgs.y != null ? point() : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    el.dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0 }));
  };

  if (__milimAction === "snapshot") {
    const max = Math.min(Math.max(Number(__milimArgs.max_chars) || 12000, 1000), 40000);
    const elements = Array.from(D.querySelectorAll("button,a,input,textarea,select,[role],[aria-label],[data-testid]"))
      .slice(0, 100)
      .map(describe);
    return {
      ok: true,
      url: W.location.href,
      title: D.title || "",
      text: (D.body?.innerText || "").trim().slice(0, max),
      elements
    };
  }

  if (__milimAction === "click") {
    const el = pick();
    if (!el) return { ok: false, error: "No preview element matched the click target." };
    mouse(el, "mousemove");
    mouse(el, "mousedown");
    mouse(el, "mouseup");
    mouse(el, "click");
    return { ok: true, clicked: describe(el) };
  }

  if (__milimAction === "type_text") {
    const text = String(__milimArgs.text ?? "");
    const el = pick() || D.activeElement;
    if (!el) return { ok: false, error: "No preview element matched the typing target." };
    el.focus?.();
    if ("value" in el) {
      el.value = `${el.value ?? ""}${text}`;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = `${el.textContent ?? ""}${text}`;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else {
      return { ok: false, error: "Matched element is not text-editable.", target: describe(el) };
    }
    return { ok: true, typed: text.length, target: describe(el) };
  }

  if (__milimAction === "key_press") {
    const key = String(__milimArgs.key ?? "");
    const el = pick() || D.activeElement || D.body;
    el.focus?.();
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    return { ok: true, pressed: key, target: describe(el) };
  }

  if (__milimAction === "scroll") {
    const el = __milimArgs.selector || __milimArgs.text ? pick() : null;
    const x = Number(__milimArgs.x ?? __milimArgs.scroll_x ?? 0);
    const y = Number(__milimArgs.y ?? __milimArgs.scroll_y ?? __milimArgs.amount ?? 0);
    if (el?.scrollBy) el.scrollBy({ left: x, top: y, behavior: "auto" });
    else W.scrollBy({ left: x, top: y, behavior: "auto" });
    return { ok: true, scrolled: { x, y }, target: el ? describe(el) : "window" };
  }

  return { ok: false, error: `Unknown preview action: ${__milimAction}` };
} catch (error) {
  return { ok: false, error: String(error?.message || error), stack: String(error?.stack || "") };
}
"#;

#[derive(Clone, Debug)]
struct PreviewTarget {
    label: String,
    url: Option<String>,
    native: bool,
}

#[derive(Default)]
pub struct PreviewToolState {
    app: RwLock<Option<AppHandle<Wry>>>,
    target: RwLock<Option<PreviewTarget>>,
}

pub type SharedPreviewToolState = Arc<PreviewToolState>;

impl PreviewToolState {
    pub fn set_app(&self, app: AppHandle<Wry>) {
        if let Ok(mut current) = self.app.write() {
            *current = Some(app);
        }
    }

    pub fn set_target(&self, label: Option<String>, url: Option<String>, native: bool) {
        if let Ok(mut current) = self.target.write() {
            *current = label.map(|label| PreviewTarget { label, url, native });
        }
    }
}

#[tauri::command]
pub fn set_active_preview_target(
    state: tauri::State<'_, SharedPreviewToolState>,
    label: Option<String>,
    url: Option<String>,
    native: bool,
) {
    state.set_target(label, url, native);
}

pub fn preview_tools(state: SharedPreviewToolState) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(PreviewDomSnapshotTool { state: state.clone() }),
        Arc::new(PreviewClickTool { state: state.clone() }),
        Arc::new(PreviewTypeTextTool { state: state.clone() }),
        Arc::new(PreviewKeyPressTool { state: state.clone() }),
        Arc::new(PreviewScrollTool { state }),
    ]
}

fn run_preview_action(state: &SharedPreviewToolState, action: &str, args: Value) -> Result<Value> {
    let target = state
        .target
        .read()
        .ok()
        .and_then(|target| target.clone())
        .ok_or_else(|| Error::InvalidRequest("No active preview panel is available.".to_string()))?;
    let app = state
        .app
        .read()
        .ok()
        .and_then(|app| app.clone())
        .ok_or_else(|| Error::InvalidRequest("Preview tools are not ready yet.".to_string()))?;
    let webview = app
        .get_webview(&target.label)
        .ok_or_else(|| Error::InvalidRequest("The active preview webview is no longer available.".to_string()))?;
    let action_json = serde_json::to_string(action).map_err(|e| Error::Other(e.to_string()))?;
    let args_json = serde_json::to_string(&args).map_err(|e| Error::Other(e.to_string()))?;
    let script = format!(
        "(() => {{ const __milimAction = {action_json}; const __milimArgs = {args_json}; const __milimNative = {}; {PREVIEW_ACTION_JS} }})()",
        if target.native { "true" } else { "false" },
    );
    let (tx, rx) = mpsc::channel();
    webview
        .eval_with_callback(script, move |raw| {
            let _ = tx.send(raw);
        })
        .map_err(|e| Error::Other(format!("preview eval failed: {e}")))?;
    let raw = rx
        .recv_timeout(PREVIEW_EVAL_TIMEOUT)
        .map_err(|_| Error::Other("preview tool timed out".to_string()))?;
    let mut result = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({ "ok": true, "result": raw }));
    if let Value::Object(map) = &mut result {
        map.insert("preview_url".to_string(), json!(target.url));
    }
    Ok(result)
}

#[derive(Debug, Deserialize)]
struct DomSnapshotArgs {
    #[serde(default)]
    max_chars: Option<u32>,
}

pub struct PreviewDomSnapshotTool {
    state: SharedPreviewToolState,
}

#[async_trait]
impl Tool for PreviewDomSnapshotTool {
    fn name(&self) -> &str {
        "preview_dom_snapshot"
    }

    fn description(&self) -> &str {
        "Inspect the active Milim preview side panel. Returns visible text, URL/title, and up to 100 clickable/form elements. Always scoped to the preview; it does not read the OS screen."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "max_chars": { "type": "integer", "description": "Maximum visible text characters to return, default 12000." }
            }
        })
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        let args: DomSnapshotArgs = serde_json::from_value(args).unwrap_or(DomSnapshotArgs { max_chars: None });
        run_preview_action(&self.state, "snapshot", json!({ "max_chars": args.max_chars }))
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct PreviewTargetArgs {
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
}

pub struct PreviewClickTool {
    state: SharedPreviewToolState,
}

#[async_trait]
impl Tool for PreviewClickTool {
    fn name(&self) -> &str {
        "preview_click"
    }

    fn description(&self) -> &str {
        "Click inside the active Milim preview side panel by CSS selector, visible text, or x/y preview coordinates. Does not move the OS mouse."
    }

    fn input_schema(&self) -> Value {
        target_schema()
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        let args = serde_json::to_value(normalize_target_args(args)?).map_err(|e| Error::Other(e.to_string()))?;
        run_preview_action(&self.state, "click", args)
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct TypeTextArgs {
    text: String,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
}

pub struct PreviewTypeTextTool {
    state: SharedPreviewToolState,
}

#[async_trait]
impl Tool for PreviewTypeTextTool {
    fn name(&self) -> &str {
        "preview_type_text"
    }

    fn description(&self) -> &str {
        "Type text into a focused or targeted field inside the active Milim preview side panel. Does not use the OS keyboard."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": { "type": "string" },
                "selector": { "type": "string", "description": "Optional CSS selector for the input/textarea/contenteditable target." },
                "x": { "type": "number", "description": "Optional x coordinate in preview pixels or 0-1 relative position." },
                "y": { "type": "number", "description": "Optional y coordinate in preview pixels or 0-1 relative position." }
            },
            "required": ["text"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        let args: TypeTextArgs = serde_json::from_value(args)
            .map_err(|e| Error::InvalidRequest(format!("invalid preview_type_text arguments: {e}")))?;
        let args = serde_json::to_value(args).map_err(|e| Error::Other(e.to_string()))?;
        run_preview_action(&self.state, "type_text", args)
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct KeyPressArgs {
    key: String,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

pub struct PreviewKeyPressTool {
    state: SharedPreviewToolState,
}

#[async_trait]
impl Tool for PreviewKeyPressTool {
    fn name(&self) -> &str {
        "preview_key_press"
    }

    fn description(&self) -> &str {
        "Dispatch a key press inside the active Milim preview side panel. Does not use the OS keyboard."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "key": { "type": "string", "description": "Key value such as Enter, Escape, Tab, ArrowDown, or a character." },
                "selector": { "type": "string" },
                "text": { "type": "string", "description": "Optional visible text target." }
            },
            "required": ["key"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        let args: KeyPressArgs = serde_json::from_value(args)
            .map_err(|e| Error::InvalidRequest(format!("invalid preview_key_press arguments: {e}")))?;
        let args = serde_json::to_value(args).map_err(|e| Error::Other(e.to_string()))?;
        run_preview_action(&self.state, "key_press", args)
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct ScrollArgs {
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    amount: Option<f64>,
}

pub struct PreviewScrollTool {
    state: SharedPreviewToolState,
}

#[async_trait]
impl Tool for PreviewScrollTool {
    fn name(&self) -> &str {
        "preview_scroll"
    }

    fn description(&self) -> &str {
        "Scroll the active Milim preview side panel or a matched scrollable element. Does not use the OS mouse wheel."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "selector": { "type": "string" },
                "text": { "type": "string" },
                "x": { "type": "number", "description": "Horizontal pixels to scroll." },
                "y": { "type": "number", "description": "Vertical pixels to scroll." },
                "amount": { "type": "number", "description": "Vertical pixels to scroll when y is omitted." }
            }
        })
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        let args: ScrollArgs = serde_json::from_value(args)
            .map_err(|e| Error::InvalidRequest(format!("invalid preview_scroll arguments: {e}")))?;
        let args = serde_json::to_value(args).map_err(|e| Error::Other(e.to_string()))?;
        run_preview_action(&self.state, "scroll", args)
    }
}

fn normalize_target_args(args: Value) -> Result<PreviewTargetArgs> {
    serde_json::from_value(args)
        .map_err(|e| Error::InvalidRequest(format!("invalid preview target arguments: {e}")))
}

fn target_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "selector": { "type": "string", "description": "CSS selector inside the preview document." },
            "text": { "type": "string", "description": "Visible text to match when selector is omitted." },
            "x": { "type": "number", "description": "Preview x coordinate in pixels, or 0-1 for relative position." },
            "y": { "type": "number", "description": "Preview y coordinate in pixels, or 0-1 for relative position." }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_preview_tools() {
        let state = Arc::new(PreviewToolState::default());
        let mut names: Vec<String> = preview_tools(state).iter().map(|tool| tool.name().to_string()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "preview_click".to_string(),
                "preview_dom_snapshot".to_string(),
                "preview_key_press".to_string(),
                "preview_scroll".to_string(),
                "preview_type_text".to_string()
            ]
        );
    }

    #[test]
    fn target_schema_supports_selector_text_and_coordinates() {
        let schema = target_schema();
        assert!(schema["properties"]["selector"].is_object());
        assert!(schema["properties"]["text"].is_object());
        assert!(schema["properties"]["x"].is_object());
        assert!(schema["properties"]["y"].is_object());
    }
}
