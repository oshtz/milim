use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Emitter, Manager, Runtime, Url, Webview};

pub const PREVIEW_WEBVIEW_NAVIGATION_EVENT: &str = "milim://preview-webview-navigation";
const PREVIEW_WEBVIEW_LABEL_PREFIX: &str = "artifact-browser-";

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
struct PreviewWebviewNavigationPayload {
    label: String,
    url: String,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

pub fn handle_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if !is_preview_label(webview.label()) {
        return;
    }
    let state = match payload.event() {
        PageLoadEvent::Started => "loading",
        PageLoadEvent::Finished => "ready",
    };
    let event = PreviewWebviewNavigationPayload {
        label: webview.label().to_string(),
        url: payload.url().to_string(),
        state,
        message: None,
    };
    emit_navigation(webview, event);
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("preview-webview-navigation")
        .on_navigation(|webview, url| {
            if !is_preview_label(webview.label()) {
                return true;
            }
            let allowed = preview_url_allowed(url);
            emit_navigation(
                webview,
                PreviewWebviewNavigationPayload {
                    label: webview.label().to_string(),
                    url: url.to_string(),
                    state: if allowed { "navigated" } else { "error" },
                    message: (!allowed).then(|| {
                        "Blocked navigation: preview URLs must use HTTPS or loopback HTTP."
                            .to_string()
                    }),
                },
            );
            allowed
        })
        .build()
}

fn emit_navigation<R: Runtime>(
    webview: &Webview<R>,
    event: PreviewWebviewNavigationPayload,
) {
    if let Some(main) = webview.get_webview("main") {
        let _ = main.emit(PREVIEW_WEBVIEW_NAVIGATION_EVENT, event);
    }
}

#[tauri::command]
pub fn preview_webview_navigate(
    app: tauri::AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    let webview = preview_webview(&app, &label)?;
    let url = allowed_preview_url(&url)?;
    webview.navigate(url).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn preview_webview_reload(app: tauri::AppHandle, label: String) -> Result<(), String> {
    preview_webview(&app, &label)?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn preview_webview_history(
    app: tauri::AppHandle,
    label: String,
    delta: i32,
) -> Result<(), String> {
    if delta != -1 && delta != 1 {
        return Err("preview history delta must be -1 or 1".to_string());
    }
    preview_webview(&app, &label)?
        .eval(format!("history.go({delta})"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn preview_webview_url(app: tauri::AppHandle, label: String) -> Result<String, String> {
    preview_webview(&app, &label)?
        .url()
        .map(|url| url.to_string())
        .map_err(|error| error.to_string())
}

fn preview_webview(app: &tauri::AppHandle, label: &str) -> Result<Webview, String> {
    if !is_preview_label(label) {
        return Err("invalid preview webview label".to_string());
    }
    app.get_webview(label)
        .ok_or_else(|| "preview webview is no longer available".to_string())
}

fn allowed_preview_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "invalid preview URL".to_string())?;
    if preview_url_allowed(&url) {
        Ok(url)
    } else {
        Err("preview URL must use HTTPS or loopback HTTP".to_string())
    }
}

fn preview_url_allowed(url: &Url) -> bool {
    url.scheme() == "https"
        || (url.scheme() == "http"
            && is_loopback_host(url.host_str().unwrap_or_default()))
}

fn is_preview_label(label: &str) -> bool {
    label.starts_with(PREVIEW_WEBVIEW_LABEL_PREFIX)
        && label[PREVIEW_WEBVIEW_LABEL_PREFIX.len()..]
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':'))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_preview_navigation_restricts_labels_and_urls() {
        assert!(is_preview_label("artifact-browser-session-1"));
        assert!(!is_preview_label("main"));
        assert!(allowed_preview_url("https://example.com/path").is_ok());
        assert!(allowed_preview_url("http://127.0.0.1:4173/").is_ok());
        assert!(allowed_preview_url("http://[::1]:4173/").is_ok());
        assert!(allowed_preview_url("http://example.com/").is_err());
        assert!(allowed_preview_url("javascript:alert(1)").is_err());
        assert!(!preview_url_allowed(
            &Url::parse("http://example.com/redirected").unwrap()
        ));
    }
}
