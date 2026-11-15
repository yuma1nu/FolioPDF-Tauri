use crate::{runtime, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, sync::{Mutex, Arc, atomic::{AtomicBool, Ordering}}};
use tauri::{Emitter, Manager, State, WebviewWindow};

#[derive(Clone, Deserialize, Serialize)]
pub struct PageMapping { source: u32, rotation: u32 }
struct Page { width: f64, height: f64 }
struct Prepared {
    revision: u64,
    dir: Arc<tempfile::TempDir>,
    selection: Vec<usize>,
    pages: Vec<Page>,
}
struct Job {
    owner: u32,
    dir: tempfile::TempDir,
    pages: Vec<PageMapping>,
    title: String,
    password: Option<String>,
    source_ready: bool,
    source_receiving: bool,
    source_error: Option<String>,
    revision: u64,
    prepared: Option<Prepared>,
    #[cfg(windows)]
    printer: Option<crate::native_printer::Settings>,
    printer_revision: u64,
    configuring: bool,
    sending: Option<Arc<AtomicBool>>,
}
#[derive(Default)]
pub struct PrintJobs { jobs: Mutex<HashMap<String, Job>> }

fn token(window: &WebviewWindow) -> Result<&str> {
    window.label().strip_prefix("print-").ok_or_else(|| "印刷ウィンドウではありません。".into())
}

#[tauri::command]
pub async fn print_begin(app: tauri::AppHandle, window: WebviewWindow, jobs: State<'_, PrintJobs>, title: String, pages: Vec<PageMapping>, password: Option<String>) -> Result<String> {
    if pages.is_empty() || pages.len() > 200_000 || pages.iter().any(|p| ![0, 90, 180, 270].contains(&p.rotation)) {
        return Err("印刷ページが不正です。".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    jobs.jobs.lock().unwrap().insert(token.clone(), Job {
        owner: runtime::id(window.label())?, dir: tempfile::tempdir().map_err(|e| e.to_string())?,
        pages, title, password, source_ready: false, source_receiving: false, source_error: None, revision: 0, prepared: None,
        #[cfg(windows)] printer: None,
        printer_revision: 0, configuring: false, sending: None,
    });
    if let Err(e) = tauri::WebviewWindowBuilder::new(&app, format!("print-{token}"), tauri::WebviewUrl::App("print.html".into()))
        .title("印刷 — Folio PDF").inner_size(1080., 800.).min_inner_size(760., 560.).build() {
        jobs.jobs.lock().unwrap().remove(&token);
        return Err(e.to_string());
    }
    Ok(token)
}

#[tauri::command]
pub async fn print_source(app: tauri::AppHandle, window: WebviewWindow, jobs: State<'_, PrintJobs>, request: tauri::ipc::Request<'_>) -> Result<()> {
    let token = request.headers().get("folio-print-job").and_then(|v| v.to_str().ok()).ok_or("印刷情報がありません。")?;
    let data = match request.body() { tauri::ipc::InvokeBody::Raw(data) => data, _ => return Err("PDFデータが不正です。".into()) };
    if !data.windows(5).take(1024).any(|v| v == b"%PDF-") { return Err("PDFデータが不正です。".into()); }
    let path = {
        let mut jobs = jobs.jobs.lock().unwrap();
        let job = jobs.get_mut(token).ok_or("印刷画面が閉じられました。")?;
        if job.owner != runtime::id(window.label())? || job.source_ready || job.source_receiving { return Err("印刷元が異なるか、受け渡しが完了しています。".into()); }
        job.source_receiving = true;
        job.dir.path().join("source.pdf")
    };
    if let Err(e) = fs::write(path, data) {
        let message = format!("印刷用PDFを受け取れませんでした: {e}");
        if let Some(job) = jobs.jobs.lock().unwrap().get_mut(token) { job.source_error = Some(message.clone()); job.source_receiving = false; }
        let _ = app.emit_to(format!("print-{token}"), "folio-print-source-error", &message);
        return Err(message);
    }
    {
        let mut jobs = jobs.jobs.lock().unwrap();
        let job = jobs.get_mut(token).ok_or("印刷画面が閉じられました。")?;
        job.source_ready = true; job.source_receiving = false;
    }
    if let Some(w) = app.get_webview_window(&format!("print-{token}")) { w.emit("folio-print-source", ()).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
pub async fn print_payload(window: WebviewWindow, jobs: State<'_, PrintJobs>) -> Result<Value> {
    let jobs = jobs.jobs.lock().unwrap();
    let job = jobs.get(token(&window)?).ok_or("印刷ジョブがありません。")?;
    Ok(json!({ "title":job.title, "pages":job.pages, "password":job.password, "sourceReady":job.source_ready,
        "sourceError":job.source_error, "preparedCount":job.prepared.as_ref().map(|p|p.pages.len()).unwrap_or(0) }))
}

#[tauri::command]
pub async fn read_print_source(window: WebviewWindow, jobs: State<'_, PrintJobs>) -> Result<tauri::ipc::Response> {
    let path = {
        let jobs = jobs.jobs.lock().unwrap();
        let job = jobs.get(token(&window)?).ok_or("印刷ジョブがありません。")?;
        if !job.source_ready { return Err("PDFを受け渡しています。".into()); }
        job.dir.path().join("source.pdf")
    };
    Ok(tauri::ipc::Response::new(fs::read(path).map_err(|e| e.to_string())?))
}

fn validate_selection(selection: &[usize], count: usize) -> Result<()> {
    if selection.is_empty() || selection.iter().any(|&p| p >= count) || selection.windows(2).any(|w| w[0] >= w[1]) {
        return Err("印刷するページを文書の順序で指定してください。".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_print(window: WebviewWindow, jobs: State<'_, PrintJobs>, selection: Vec<usize>) -> Result<u64> {
    let mut jobs = jobs.jobs.lock().unwrap();
    let job = jobs.get_mut(token(&window)?).ok_or("印刷ジョブがありません。")?;
    if job.sending.is_some() || job.configuring { return Err("プリンターの処理が完了するまでお待ちください。".into()); }
    if !job.source_ready { return Err("PDFを読み込んでいます。".into()); }
    validate_selection(&selection, job.pages.len())?;
    job.revision += 1;
    job.prepared = Some(Prepared { revision: job.revision, dir: Arc::new(tempfile::tempdir().map_err(|e| e.to_string())?), selection, pages: vec![] });
    Ok(job.revision)
}

#[tauri::command]
pub async fn print_page(window: WebviewWindow, jobs: State<'_, PrintJobs>, request: tauri::ipc::Request<'_>) -> Result<()> {
    let meta: Value = serde_json::from_str(request.headers().get("folio-print").and_then(|v| v.to_str().ok()).ok_or("印刷情報がありません。")?).map_err(|e| e.to_string())?;
    let mut jobs = jobs.jobs.lock().unwrap();
    let job = jobs.get_mut(token(&window)?).ok_or("印刷ジョブがありません。")?;
    let prepared = job.prepared.as_mut().ok_or("印刷準備をキャンセルしました。")?;
    if meta["revision"].as_u64() != Some(prepared.revision) { return Err("印刷対象が変更されました。".into()); }
    let index = meta["index"].as_u64().ok_or("ページ番号が不正です。")? as usize;
    if index != prepared.pages.len() || index >= prepared.selection.len() || meta["page"].as_u64() != Some(prepared.selection[index] as u64) {
        return Err("印刷ページの順序が不正です。".into());
    }
    let width = meta["width"].as_f64().filter(|v| v.is_finite() && *v > 0.).ok_or("用紙幅が不正です。")?;
    let height = meta["height"].as_f64().filter(|v| v.is_finite() && *v > 0.).ok_or("用紙高が不正です。")?;
    let data = match request.body() { tauri::ipc::InvokeBody::Raw(data) => data, _ => return Err("印刷データが不正です。".into()) };
    if !data.starts_with(b"\x89PNG\r\n\x1a\n") || data.len() > 200_000_000 { return Err("印刷画像が不正です。".into()); }
    fs::write(prepared.dir.path().join(format!("{index}.png")), data).map_err(|e| e.to_string())?;
    prepared.pages.push(Page { width, height });
    Ok(())
}

#[tauri::command]
pub async fn read_print_page(window: WebviewWindow, jobs: State<'_, PrintJobs>, index: usize, revision: u64) -> Result<tauri::ipc::Response> {
    let path = {
        let jobs = jobs.jobs.lock().unwrap();
        let job = jobs.get(token(&window)?).ok_or("印刷ジョブがありません。")?;
        let prepared = job.prepared.as_ref().ok_or("印刷準備をキャンセルしました。")?;
        if revision != prepared.revision || index >= prepared.pages.len() { return Err("印刷ページがありません。".into()); }
        prepared.dir.path().join(format!("{index}.png"))
    };
    Ok(tauri::ipc::Response::new(fs::read(path).map_err(|e| e.to_string())?))
}

#[tauri::command]
pub async fn cancel_print_preparation(window: WebviewWindow, jobs: State<'_, PrintJobs>, revision: u64) -> Result<()> {
    let mut jobs = jobs.jobs.lock().unwrap();
    let job = jobs.get_mut(token(&window)?).ok_or("印刷ジョブがありません。")?;
    if job.sending.is_some() { return Err("プリンターへ送信しています。".into()); }
    if job.prepared.as_ref().is_some_and(|p| p.revision == revision) { job.prepared = None; }
    Ok(())
}

#[tauri::command]
pub async fn print_cancel(app: tauri::AppHandle, window: WebviewWindow, jobs: State<'_, PrintJobs>, job: String) -> Result<()> {
    let owner = runtime::id(window.label())?;
    {
        let mut jobs = jobs.jobs.lock().unwrap();
        if jobs.get(&job).is_some_and(|j| j.owner != owner) { return Err("印刷元が異なります。".into()); }
        jobs.remove(&job);
    }
    if let Some(w) = app.get_webview_window(&format!("print-{job}")) { let _ = w.destroy(); }
    Ok(())
}

#[tauri::command]
pub async fn get_printers(window: WebviewWindow) -> Result<Value> {
    token(&window)?;
    #[cfg(windows)] { tokio::task::spawn_blocking(|| crate::native_printer::list().map(|value| json!(value))).await.map_err(|e| e.to_string())? }
    #[cfg(not(windows))] { Err("プリンターへの直接送信はWindows版で利用できます。".into()) }
}

#[tauri::command]
pub async fn select_printer(window: WebviewWindow, jobs: State<'_, PrintJobs>, name: String) -> Result<Value> {
    let key = token(&window)?.to_string();
    {
        let mut jobs = jobs.jobs.lock().unwrap(); let job = jobs.get_mut(&key).ok_or("印刷ジョブがありません。")?;
        if job.sending.is_some() || job.configuring { return Err("プリンターの処理が完了するまでお待ちください。".into()); }
        job.configuring = true;
    }
    #[cfg(windows)] {
        let result = tokio::task::spawn_blocking(move || crate::native_printer::Settings::load(name)).await.map_err(|e| e.to_string()).and_then(|result| result);
        let mut jobs = jobs.jobs.lock().unwrap(); let job = jobs.get_mut(&key).ok_or("印刷画面が閉じられました。")?; job.configuring = false;
        let settings = result?; job.printer_revision += 1;
        let choice = json!({"name":settings.name,"revision":job.printer_revision}); job.printer = Some(settings); Ok(choice)
    }
    #[cfg(not(windows))] { jobs.jobs.lock().unwrap().get_mut(&key).unwrap().configuring = false; Err("Windows版で利用できます。".into()) }
}

#[tauri::command]
pub async fn driver_properties(window: WebviewWindow, jobs: State<'_, PrintJobs>, printer_revision: u64) -> Result<Value> {
    let key = token(&window)?.to_string();
    #[cfg(windows)] {
        let owner = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
        let settings = {
            let mut jobs = jobs.jobs.lock().unwrap(); let job = jobs.get_mut(&key).ok_or("印刷ジョブがありません。")?;
            if job.sending.is_some() || job.configuring { return Err("プリンターの処理が完了するまでお待ちください。".into()); }
            if job.printer_revision != printer_revision { return Err("プリンターの設定が変更されました。".into()); }
            let settings = job.printer.clone().ok_or("プリンターを選択してください。")?; job.configuring = true; settings
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        let result = match std::thread::Builder::new().name("folio-printer-properties".into()).spawn(move || { let _ = tx.send(settings.properties(owner)); }) {
            Ok(_) => rx.await.map_err(|e| e.to_string()).and_then(|result| result),
            Err(e) => Err(e.to_string()),
        };
        let mut jobs = jobs.jobs.lock().unwrap(); let job = jobs.get_mut(&key).ok_or("印刷画面が閉じられました。")?; job.configuring = false;
        let changed = if let Some(settings) = result? { job.printer = Some(settings); job.printer_revision += 1; true } else { false };
        Ok(json!({"name":job.printer.as_ref().unwrap().name,"revision":job.printer_revision,"changed":changed}))
    }
    #[cfg(not(windows))] { Err("Windows版で利用できます。".into()) }
}

#[tauri::command]
pub async fn direct_print(window: WebviewWindow, jobs: State<'_, PrintJobs>, revision: u64, printer_revision: u64, fit: bool) -> Result<Value> {
    let key = token(&window)?.to_string();
    #[cfg(windows)] {
        let (settings, title, pages, keep_files, cancelled) = {
            let mut jobs = jobs.jobs.lock().unwrap(); let job = jobs.get_mut(&key).ok_or("印刷ジョブがありません。")?;
            let prepared = job.prepared.as_ref().ok_or("印刷準備が完了していません。")?;
            if prepared.revision != revision || prepared.pages.is_empty() || prepared.pages.len() != prepared.selection.len() { return Err("印刷準備が完了していません。".into()); }
            if job.sending.is_some() || job.configuring { return Err("プリンターの処理が完了するまでお待ちください。".into()); }
            if job.printer_revision != printer_revision { return Err("プリンターの設定が変更されました。確認してから印刷してください。".into()); }
            let settings = job.printer.clone().ok_or("プリンターを選択してください。")?;
            let pages = prepared.pages.iter().enumerate().map(|(i,p)| crate::native_printer::SpoolPage { path:prepared.dir.path().join(format!("{i}.png")),width:p.width,height:p.height }).collect();
            let cancelled = Arc::new(AtomicBool::new(false)); job.sending = Some(cancelled.clone());
            (settings, job.title.clone(), pages, prepared.dir.clone(), cancelled)
        };
        let result = tokio::task::spawn_blocking(move || {
            let _keep_files = keep_files;
            crate::native_printer::submit(settings,title,pages,fit,cancelled)
        }).await.map_err(|e| e.to_string()).and_then(|result| result);
        if let Some(job) = jobs.jobs.lock().unwrap().get_mut(&key) { job.sending = None; }
        result.map(|receipt| json!(receipt))
    }
    #[cfg(not(windows))] { Err("Windows版で利用できます。".into()) }
}

#[tauri::command]
pub async fn cancel_direct_print(window: WebviewWindow, jobs: State<'_, PrintJobs>) -> Result<()> {
    if let Some(flag) = jobs.jobs.lock().unwrap().get(token(&window)?).and_then(|j|j.sending.as_ref()) { flag.store(true, Ordering::Relaxed); } Ok(())
}

pub fn destroyed(app: &tauri::AppHandle, label: &str) {
    let state = app.state::<PrintJobs>();
    let mut jobs = state.jobs.lock().unwrap();
    if let Some(token) = label.strip_prefix("print-") {
        if let Some(job) = jobs.remove(token) { if let Some(flag) = job.sending { flag.store(true, Ordering::Relaxed); } }
    }
    else if let Ok(owner) = runtime::id(label) {
        jobs.retain(|token, j| {
            if j.owner != owner { return true; }
            let Some(window) = app.get_webview_window(&format!("print-{token}")) else { return false; };
            if !j.source_ready && !j.source_receiving {
                let message = "元のウィンドウが閉じられました。PDFを開いて印刷し直してください。".to_string();
                j.source_error = Some(message.clone()); let _ = window.emit("folio-print-source-error", message);
            }
            true
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_pages_must_be_nonempty_unique_and_in_document_order() {
        assert!(validate_selection(&[0, 2, 3], 4).is_ok());
        for selection in [vec![], vec![4], vec![1, 1], vec![2, 0]] { assert!(validate_selection(&selection, 4).is_err()); }
    }
}
