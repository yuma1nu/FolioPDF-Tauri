use crate::{atomic_write, pdf_path, state_path, Files, Result};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, fs, path::PathBuf, sync::{Mutex, atomic::{AtomicU32, Ordering}}, time::Duration};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;

pub struct Transfer {
    source: u32, target: u32, metadata: Value, bytes: Vec<u8>, reply: Option<oneshot::Sender<bool>>,
}
#[derive(Default)]
pub struct Runtime {
    pub session: Mutex<Value>,
    pub live: Mutex<HashSet<u32>>,
    next: AtomicU32,
    transfers: Mutex<HashMap<String, Transfer>>,
    pub owners: Mutex<HashMap<PathBuf, (u32, String)>>,
    pub pending: Mutex<HashMap<u32, Vec<String>>>,
    warning: Mutex<Option<String>>,
}
pub fn id(label: &str) -> Result<u32> {
    if label == "main" { return Ok(1); }
    label.strip_prefix("folio-").and_then(|s| s.parse().ok()).ok_or_else(|| "文書ウィンドウではありません。".into())
}
pub fn label(id: u32) -> String { if id == 1 { "main".into() } else { format!("folio-{id}") } }
pub fn empty() -> Value { json!({"settings":{"theme":"system","openMode":"tab","restore":true},"recent":[],"views":{},"windows":{}}) }
pub fn migrate(mut value: Value) -> Value {
    if !value.is_object() { return empty(); }
    if !value["windows"].is_object() {
        value["windows"] = json!({"1":{"tabs":value["tabs"].as_array().cloned().unwrap_or_default(),"active":value["active"]}});
        value.as_object_mut().unwrap().remove("tabs"); value.as_object_mut().unwrap().remove("active");
    }
    for (key, fallback) in [("settings", empty()["settings"].clone()), ("recent", json!([])), ("views", json!({}))] {
        if value[key].is_null() { value[key] = fallback; }
    }
    if !value["settings"].is_object() { value["settings"] = empty()["settings"].clone(); }
    for (key, allowed, fallback) in [("theme", &["system","light","dark"][..], "system"), ("openMode", &["tab","window"][..], "tab")] {
        if !value["settings"][key].as_str().is_some_and(|s| allowed.contains(&s)) { value["settings"][key] = json!(fallback); }
    }
    if !value["settings"]["restore"].is_boolean() { value["settings"]["restore"] = json!(true); }
    if !value["recent"].is_array() { value["recent"] = json!([]); }
    if !value["views"].is_object() { value["views"] = json!({}); }
    if let Some(windows) = value["windows"].as_object_mut() {
        windows.retain(|key, window| key.parse::<u32>().is_ok_and(|n| n > 0) && window.is_object());
        for window in windows.values_mut() { if !window["tabs"].is_array() { window["tabs"] = json!([]); } }
    }
    value
}
pub fn all_paths(value: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(items) = value["recent"].as_array() { for item in items { if let Some(p) = item["path"].as_str() { paths.push(p.into()); } } }
    if let Some(windows) = value["windows"].as_object() { for window in windows.values() {
        if let Some(tabs) = window["tabs"].as_array() { for tab in tabs { if let Some(p) = tab["path"].as_str() { paths.push(p.into()); } } }
    } }
    paths
}
fn save(app: &tauri::AppHandle, value: &Value) -> Result<()> {
    let p = state_path(app)?; fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    atomic_write(&p, &serde_json::to_vec(value).map_err(|e| e.to_string())?)
}
pub fn initialize(app: &tauri::AppHandle) -> Result<()> {
    let runtime = app.state::<Runtime>(); let p = state_path(app)?;
    let value = match fs::read(&p) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => migrate(value),
            Err(_) => {
                let backup = p.with_extension(format!("corrupt-{}.json", uuid::Uuid::new_v4()));
                fs::rename(&p, &backup).map_err(|e| e.to_string())?;
                *runtime.warning.lock().unwrap() = Some(format!("設定ファイルを読み込めなかったため初期状態で起動しました。元のファイル: {}", backup.display())); empty()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => empty(),
        Err(e) => return Err(e.to_string()),
    };
    for path in all_paths(&value) { if let Ok(p) = fs::canonicalize(&path) { if pdf_path(&p.to_string_lossy()).is_ok() { app.state::<Files>().readable.lock().unwrap().insert(p); } } }
    let restore = value["settings"]["restore"].as_bool().unwrap_or(true);
    let ids: Vec<u32> = value["windows"].as_object().into_iter().flat_map(|w| w.keys()).filter_map(|s| s.parse().ok()).filter(|n| *n > 1).collect();
    runtime.next.store(ids.iter().copied().max().unwrap_or(1) + 1, Ordering::Relaxed);
    runtime.live.lock().unwrap().insert(1);
    *runtime.session.lock().unwrap() = value;
    if restore { if let Some(window) = app.get_webview_window("main") { restore_bounds(&window); } }
    if restore { for n in ids { build_window(app, n)?; } } else { runtime.session.lock().unwrap()["windows"] = json!({}); }
    let paths = grant_launch(app, std::env::args().skip(1).collect(), &std::env::current_dir().unwrap_or_default().to_string_lossy());
    runtime.pending.lock().unwrap().entry(1).or_default().extend(paths);
    Ok(())
}
fn build_window(app: &tauri::AppHandle, n: u32) -> Result<()> {
    if app.state::<Runtime>().live.lock().unwrap().is_empty() { app.state::<Runtime>().session.lock().unwrap()["windows"] = json!({}); }
    app.state::<Runtime>().live.lock().unwrap().insert(n);
    let window = match tauri::WebviewWindowBuilder::new(app, label(n), tauri::WebviewUrl::App("index.html".into()))
        .title("Folio PDF").inner_size(1280., 850.).min_inner_size(900., 600.).decorations(false).build() {
        Ok(window) => window,
        Err(e) => { app.state::<Runtime>().live.lock().unwrap().remove(&n); return Err(e.to_string()); }
    };
    restore_bounds(&window);
    broadcast_windows(app); Ok(())
}
fn bounds(window: &WebviewWindow, previous: Value) -> Value {
    if window.is_maximized().unwrap_or(false) { let mut value = if previous.is_object() { previous } else { json!({}) }; value["maximized"] = json!(true); return value; }
    if window.is_minimized().unwrap_or(false) { return previous; }
    match (window.outer_position(), window.inner_size()) { (Ok(position), Ok(size)) => json!({"x":position.x,"y":position.y,"width":size.width,"height":size.height,"maximized":false}), _ => previous }
}
fn restore_bounds(window: &WebviewWindow) {
    let Ok(n) = id(window.label()) else { return; };
    let value = window.state::<Runtime>().session.lock().unwrap()["windows"][n.to_string()]["bounds"].clone();
    if let (Some(x),Some(y),Some(width),Some(height)) = (value["x"].as_i64(),value["y"].as_i64(),value["width"].as_u64(),value["height"].as_u64()) {
        let visible = window.available_monitors().unwrap_or_default().iter().any(|m| {
            let p = m.position(); let size = m.size(); x + width as i64 > p.x as i64 + 40 && y + height as i64 > p.y as i64 + 40 && x < p.x as i64 + size.width as i64 - 40 && y < p.y as i64 + size.height as i64 - 40
        });
        if visible && (400..=16000).contains(&width) && (300..=16000).contains(&height) {
            let _ = window.set_size(tauri::PhysicalSize::new(width as u32,height as u32)); let _ = window.set_position(tauri::PhysicalPosition::new(x as i32,y as i32));
        }
    }
    if value["maximized"] == true { let _ = window.maximize(); }
}
pub fn broadcast_windows(app: &tauri::AppHandle) { let _ = app.emit("folio-windows", ()); }
pub fn grant_launch(app: &tauri::AppHandle, args: Vec<String>, cwd: &str) -> Vec<String> {
    args.into_iter().filter_map(|p| {
        let path = PathBuf::from(p); let path = if path.is_absolute() { path } else { PathBuf::from(cwd).join(path) };
        let path = fs::canonicalize(path).ok()?; pdf_path(&path.to_string_lossy()).ok()?;
        app.state::<Files>().readable.lock().unwrap().insert(path.clone()); Some(path.to_string_lossy().into_owned())
    }).collect()
}
pub fn second_instance(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    let paths = grant_launch(app, args.into_iter().skip(1).collect(), &cwd);
    let window = app.webview_windows().into_values().find(|w| id(w.label()).is_ok() && w.is_focused().unwrap_or(false))
        .or_else(|| app.webview_windows().into_values().find(|w| id(w.label()).is_ok()));
    if let Some(window) = window {
        if let Ok(n) = id(window.label()) { app.state::<Runtime>().pending.lock().unwrap().entry(n).or_default().extend(paths); }
        let _ = window.unminimize(); let _ = window.set_focus(); let _ = window.emit("folio-launch", ());
    } else {
        let runtime = app.state::<Runtime>(); let n = runtime.next.fetch_add(1, Ordering::Relaxed);
        runtime.pending.lock().unwrap().insert(n, paths); let _ = build_window(app, n);
    }
}
pub fn destroyed(app: &tauri::AppHandle, window_label: &str) {
    let Ok(n) = id(window_label) else { return; }; let runtime = app.state::<Runtime>();
    let more = { let mut live = runtime.live.lock().unwrap(); live.remove(&n); !live.is_empty() };
    runtime.owners.lock().unwrap().retain(|_, (owner, _)| *owner != n);
    app.state::<Files>().watches.lock().unwrap().retain(|(_, owner), _| *owner != n);
    runtime.pending.lock().unwrap().remove(&n);
    runtime.transfers.lock().unwrap().retain(|_, transfer| transfer.source != n && transfer.target != n);
    if more { let mut session = runtime.session.lock().unwrap(); if let Some(w) = session["windows"].as_object_mut() { w.remove(&n.to_string()); } let _ = save(app, &session); }
    broadcast_windows(app);
}
#[tauri::command]
pub async fn load_session(app: tauri::AppHandle, window: WebviewWindow, runtime: State<'_, Runtime>) -> Result<Value> {
    let n = id(window.label())?; let session = runtime.session.lock().unwrap();
    Ok(json!({"windowId":n,"settings":session["settings"],"recent":session["recent"],"views":session["views"],
        "tabs":session["windows"][n.to_string()]["tabs"].as_array().cloned().unwrap_or_default(),
        "active":session["windows"][n.to_string()]["active"],"warning":runtime.warning.lock().unwrap().take(),"appName":app.package_info().name}))
}
#[tauri::command]
pub async fn store_session(app: tauri::AppHandle, window: WebviewWindow, runtime: State<'_, Runtime>, files: State<'_, Files>, value: Value) -> Result<()> {
    let n = id(window.label())?;
    let tabs = value["tabs"].as_array().ok_or("タブ情報が不正です。")?;
    for tab in tabs { let p = pdf_path(tab["path"].as_str().ok_or("パスが不正です。")?)?;
        if p.exists() { let p = fs::canonicalize(p).map_err(|e| e.to_string())?; if !files.readable.lock().unwrap().contains(&p) { return Err("許可されていない履歴です。".into()); } }
    }
    let mut session = runtime.session.lock().unwrap();
    let bounds = bounds(&window,session["windows"][n.to_string()]["bounds"].clone());
    session["windows"][n.to_string()] = json!({"tabs":tabs,"active":value["active"],"bounds":bounds});
    for tab in tabs { if let Some(path) = tab["path"].as_str() { session["views"][path] = tab["view"].clone(); } }
    save(&app, &session)?; drop(session); broadcast_windows(&app); Ok(())
}
#[tauri::command]
pub async fn preferences(app: tauri::AppHandle, runtime: State<'_, Runtime>, value: Value) -> Result<Value> {
    let result = { let mut session = runtime.session.lock().unwrap();
        for (key, allowed) in [("theme", &["system","light","dark"][..]), ("openMode", &["tab","window"][..])] {
            if let Some(v) = value[key].as_str() { if allowed.contains(&v) { session["settings"][key] = json!(v); } }
        }
        if let Some(v) = value["restore"].as_bool() { session["settings"]["restore"] = json!(v); }
        if value["clearHistory"] == true { session["recent"] = json!([]); session["views"] = json!({}); }
        save(&app, &session)?; json!({"settings":session["settings"],"recent":session["recent"]})
    };
    app.emit("folio-preferences", &result).map_err(|e| e.to_string())?; Ok(result)
}
#[tauri::command]
pub async fn remember_pdf(app: tauri::AppHandle, runtime: State<'_, Runtime>, files: State<'_, Files>, path: String, name: String) -> Result<()> {
    let p = fs::canonicalize(pdf_path(&path)?).map_err(|e| e.to_string())?;
    if !files.readable.lock().unwrap().contains(&p) { return Err("許可されていない履歴です。".into()); }
    let result = { let mut session = runtime.session.lock().unwrap(); let mut recent = session["recent"].as_array().cloned().unwrap_or_default();
        recent.retain(|r| r["path"] != path); recent.insert(0, json!({"path":path,"name":name})); recent.truncate(12); session["recent"] = json!(recent);
        save(&app, &session)?; json!({"settings":session["settings"],"recent":session["recent"]}) };
    app.emit("folio-preferences", result).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn list_windows(app: tauri::AppHandle, runtime: State<'_, Runtime>) -> Result<Vec<Value>> {
    let session = runtime.session.lock().unwrap(); let mut windows: Vec<_> = app.webview_windows().into_values().filter_map(|w| {
        let n = id(w.label()).ok()?; let title = session["windows"][n.to_string()]["tabs"].as_array().map(|tabs| tabs.iter().filter_map(|t| t["path"].as_str()).map(|p| p.rsplit(['\\','/']).next().unwrap_or(p)).collect::<Vec<_>>().join(", ")).filter(|s| !s.is_empty()).unwrap_or_else(|| "ホーム".into());
        Some(json!({"id":n,"title":title}))
    }).collect(); windows.sort_by_key(|v| v["id"].as_u64()); Ok(windows)
}
#[tauri::command]
pub async fn create_window(app: tauri::AppHandle, runtime: State<'_, Runtime>, paths: Option<Vec<String>>) -> Result<u32> {
    let paths = paths.unwrap_or_default();
    for path in &paths { let p = fs::canonicalize(pdf_path(path)?).map_err(|e| e.to_string())?; if !app.state::<Files>().readable.lock().unwrap().contains(&p) { return Err("許可されていないファイルです。".into()); } }
    let n = runtime.next.fetch_add(1, Ordering::Relaxed); runtime.pending.lock().unwrap().insert(n, paths);
    build_window(&app, n)?; Ok(n)
}
#[tauri::command]
pub async fn pending_paths(window: WebviewWindow, runtime: State<'_, Runtime>) -> Result<Vec<String>> { Ok(runtime.pending.lock().unwrap().remove(&id(window.label())?).unwrap_or_default()) }
#[tauri::command]
pub async fn locate_pdf(app: tauri::AppHandle, runtime: State<'_, Runtime>, path: String) -> Result<Option<Value>> {
    let p = fs::canonicalize(pdf_path(&path)?).map_err(|e| e.to_string())?;
    let owner = runtime.owners.lock().unwrap().get(&p).cloned();
    if let Some((n, doc_id)) = &owner { if let Some(w) = app.get_webview_window(&label(*n)) { let _ = w.unminimize(); let _ = w.set_focus(); let _ = w.emit("folio-activate", doc_id); } }
    Ok(owner.map(|(owner, doc_id)| json!({"owner":owner,"id":doc_id})))
}
#[tauri::command]
pub async fn claim_pdf(app: tauri::AppHandle, window: WebviewWindow, runtime: State<'_, Runtime>, path: String, doc_id: String) -> Result<bool> {
    let n = id(window.label())?; let p = fs::canonicalize(pdf_path(&path)?).map_err(|e| e.to_string())?;
    let old = { let mut owners = runtime.owners.lock().unwrap(); if let Some(old) = owners.get(&p) { Some(old.clone()) } else { owners.insert(p, (n, doc_id)); None } };
    if let Some((owner, doc_id)) = old { if let Some(w) = app.get_webview_window(&label(owner)) { let _ = w.unminimize(); let _ = w.set_focus(); let _ = w.emit("folio-activate", doc_id); } return Ok(false); }
    Ok(true)
}
#[tauri::command]
pub async fn release_pdf(window: WebviewWindow, runtime: State<'_, Runtime>, files: State<'_, Files>, doc_id: String) -> Result<()> {
    let n = id(window.label())?; runtime.owners.lock().unwrap().retain(|_, (owner, doc)| !(*owner == n && *doc == doc_id));
    files.watches.lock().unwrap().retain(|(_, owner), watch| !(*owner == n && watch.doc_id == doc_id)); Ok(())
}
#[tauri::command]
pub async fn prepare_transfer(window: WebviewWindow, runtime: State<'_, Runtime>, metadata: Value, target: Option<u32>) -> Result<String> {
    let source = id(window.label())?;
    if metadata["id"].as_str().is_none() { return Err("文書情報が不正です。".into()); }
    if let Some(target) = target { if target == source || !runtime.live.lock().unwrap().contains(&target) { return Err("移動先がありません。".into()); } }
    let target = target.unwrap_or_else(|| runtime.next.fetch_add(1, Ordering::Relaxed));
    let token = uuid::Uuid::new_v4().to_string();
    runtime.transfers.lock().unwrap().insert(token.clone(), Transfer { source, target, metadata, bytes: vec![], reply: None }); Ok(token)
}
#[tauri::command]
pub async fn transfer_document(app: tauri::AppHandle, window: WebviewWindow, runtime: State<'_, Runtime>, request: tauri::ipc::Request<'_>) -> Result<bool> {
    let source = id(window.label())?;
    let token = request.headers().get("folio-transfer").and_then(|v| v.to_str().ok()).ok_or("移動情報がありません。")?.to_string();
    let bytes = match request.body() { tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(), _ => return Err("PDFデータが不正です。".into()) };
    if !bytes.starts_with(b"%PDF-") { return Err("PDFデータが不正です。".into()); }
    let (tx, rx) = oneshot::channel();
    let target = { let mut transfers = runtime.transfers.lock().unwrap(); let t = transfers.get_mut(&token).ok_or("移動データがありません。")?;
        if t.source != source { return Err("移動元が異なります。".into()); } t.bytes = bytes; t.reply = Some(tx); t.target };
    if let Some(w) = app.get_webview_window(&label(target)) { w.emit("folio-transfer", ()).map_err(|e| e.to_string())?; let _ = w.set_focus(); }
    else if let Err(e) = build_window(&app, target) { runtime.transfers.lock().unwrap().remove(&token); return Err(e); }
    let result = tokio::time::timeout(Duration::from_secs(60), rx).await;
    runtime.transfers.lock().unwrap().remove(&token);
    match result { Ok(Ok(value)) => Ok(value), _ => Err("移動先で文書を受け取れませんでした。元のタブを保持しています。".into()) }
}
#[tauri::command]
pub async fn pending_transfers(window: WebviewWindow, runtime: State<'_, Runtime>) -> Result<Vec<Value>> {
    let n = id(window.label())?; Ok(runtime.transfers.lock().unwrap().iter().filter(|(_,t)| t.target == n && t.reply.is_some()).map(|(token,t)| json!({"token":token,"document":t.metadata})).collect())
}
#[tauri::command]
pub async fn read_transfer(window: WebviewWindow, runtime: State<'_, Runtime>, token: String) -> Result<tauri::ipc::Response> {
    let n = id(window.label())?; let transfers = runtime.transfers.lock().unwrap(); let t = transfers.get(&token).ok_or("移動データがありません。")?;
    if t.target != n { return Err("移動先が異なります。".into()); } Ok(tauri::ipc::Response::new(t.bytes.clone()))
}
#[tauri::command]
pub async fn acknowledge_transfer(window: WebviewWindow, runtime: State<'_, Runtime>, token: String, accepted: bool) -> Result<()> {
    let n = id(window.label())?; let mut transfers = runtime.transfers.lock().unwrap(); let t = transfers.get_mut(&token).ok_or("移動データがありません。")?;
    if t.target != n { return Err("移動先が異なります。".into()); }
    let reply = t.reply.take().ok_or("受け渡しはすでに完了しています。")?;
    if reply.is_closed() { return Err("移動元で受け渡しを中止しました。".into()); }
    let doc_id = t.metadata["id"].as_str().unwrap_or_default();
    let path = runtime.owners.lock().unwrap().iter().find(|(_, (owner, id))| *owner == t.source && id == doc_id).map(|(path, _)| path.clone())
        .or_else(|| t.metadata["path"].as_str().and_then(|path| fs::canonicalize(path).ok()));
    let previous = if accepted { path.as_ref().map(|p| runtime.owners.lock().unwrap().insert(p.clone(), (n, t.metadata["id"].as_str().unwrap_or_default().into()))) } else { None };
    if reply.send(accepted).is_err() {
        if let (Some(path), Some(previous)) = (path, previous) { let mut owners = runtime.owners.lock().unwrap(); if let Some(previous) = previous { owners.insert(path, previous); } else { owners.remove(&path); } }
        return Err("移動元で受け渡しを中止しました。".into());
    } Ok(())
}
#[tauri::command]
pub async fn cancel_transfer(window: WebviewWindow, runtime: State<'_, Runtime>, token: String) -> Result<()> {
    let n = id(window.label())?; let mut transfers = runtime.transfers.lock().unwrap();
    if transfers.get(&token).is_some_and(|t| t.source == n) { transfers.remove(&token); } Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn migrates_prototype_without_losing_tabs() { let value = migrate(json!({"tabs":[{"path":"example.pdf"}],"active":"example.pdf"})); assert_eq!(value["windows"]["1"]["tabs"][0]["path"], "example.pdf"); assert_eq!(all_paths(&value), vec!["example.pdf"]); }
    #[test] fn document_window_labels_are_strict() { assert_eq!(id("main").unwrap(),1); assert_eq!(id("folio-12").unwrap(),12); assert!(id("print-12").is_err()); }
    #[test] fn malformed_preferences_cannot_break_persistence() { let value=migrate(json!({"settings":false,"views":[],"recent":{},"windows":{"bad":false,"1":{"tabs":false}}}));assert_eq!(value["settings"]["openMode"],"tab");assert!(value["views"].is_object());assert!(value["recent"].is_array());assert!(value["windows"].get("bad").is_none());assert!(value["windows"]["1"]["tabs"].is_array()); }
}
