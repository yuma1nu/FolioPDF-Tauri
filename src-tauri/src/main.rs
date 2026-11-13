#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runtime;
mod printing;
use serde_json::json;
use std::{collections::{HashMap, HashSet}, fs, io::Write, path::{Path, PathBuf}, sync::Mutex, time::{Duration, UNIX_EPOCH}};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, PartialEq, Debug)]
struct Stamp { size: u64, modified: u128 }
fn stamp(path: &Path) -> Option<Stamp> { let m = fs::metadata(path).ok()?; Some(Stamp { size: m.len(), modified: m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos() }) }
pub struct Watch { doc_id: String, baseline: Option<Stamp>, seen: Option<Stamp> }
#[derive(Default)]
pub struct Files { readable: Mutex<HashSet<PathBuf>>, writable: Mutex<HashSet<PathBuf>>, watches: Mutex<HashMap<(PathBuf,u32), Watch>> }
pub type Result<T> = std::result::Result<T, String>;
pub fn pdf_path(path: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path);
    if !p.is_absolute() || !p.extension().is_some_and(|v| v.eq_ignore_ascii_case("pdf")) { return Err("PDFの絶対パスを指定してください。".into()); }
    Ok(p)
}
pub fn state_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = match std::env::var_os("FOLIO_USER_DATA") {
        Some(dir) => { let dir = PathBuf::from(dir); if !dir.is_absolute() { return Err("FOLIO_USER_DATA must be absolute".into()); } dir },
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    }; Ok(dir.join("session.json"))
}
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("保存先が不正です。")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(data).map_err(|e| e.to_string())?; temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?; Ok(())
}
fn permitted(files: &Files, path: &str) -> Result<PathBuf> {
    let p = fs::canonicalize(pdf_path(path)?).map_err(|e| e.to_string())?;
    if !files.readable.lock().unwrap().contains(&p) { return Err("先にファイル選択でPDFを開いてください。".into()); } Ok(p)
}
#[tauri::command]
async fn choose_files(app: tauri::AppHandle, window: WebviewWindow, files: State<'_, Files>) -> Result<Vec<String>> {
    let chosen = app.dialog().file().set_parent(&window).add_filter("PDF", &["pdf"]).blocking_pick_files().unwrap_or_default();
    let mut paths = Vec::new(); let mut readable = files.readable.lock().unwrap();
    for item in chosen { let p = fs::canonicalize(item.into_path().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        pdf_path(&p.to_string_lossy())?; readable.insert(p.clone()); paths.push(p.to_string_lossy().into_owned()); }
    Ok(paths)
}
#[tauri::command]
async fn read_pdf(path: String, files: State<'_, Files>) -> Result<tauri::ipc::Response> {
    let p = permitted(&files, &path)?;
    let before = stamp(&p); let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    if before != stamp(&p) { return Err("読み込み中にファイルが変更されました。少し待ってから開き直してください。".into()); }
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
async fn watch_pdf(window: WebviewWindow, path: String, doc_id: String, files: State<'_, Files>) -> Result<()> {
    let p = permitted(&files, &path)?; let current = stamp(&p);
    files.watches.lock().unwrap().insert((p,runtime::id(window.label())?), Watch { doc_id, baseline: current.clone(), seen: current }); Ok(())
}
#[tauri::command]
async fn choose_destination(app: tauri::AppHandle, window: WebviewWindow, files: State<'_, Files>, name: String) -> Result<Option<String>> {
    let chosen = app.dialog().file().set_parent(&window).add_filter("PDF", &["pdf"]).set_file_name(name).blocking_save_file();
    match chosen { None => Ok(None), Some(p) => {
        let mut p = p.into_path().map_err(|e| e.to_string())?;
        if !p.extension().is_some_and(|v| v.eq_ignore_ascii_case("pdf")) { p.set_extension("pdf"); }
        pdf_path(&p.to_string_lossy())?; files.writable.lock().unwrap().insert(p.clone()); Ok(Some(p.to_string_lossy().into_owned()))
    } }
}
#[tauri::command]
async fn write_pdf(request: tauri::ipc::Request<'_>, files: State<'_, Files>) -> Result<()> {
    let path = request.headers().get("folio-path").and_then(|v| v.to_str().ok()).ok_or("保存先がありません。")?;
    let path: String = serde_json::from_str(path).map_err(|e| e.to_string())?; let p = pdf_path(&path)?;
    let data = match request.body() { tauri::ipc::InvokeBody::Raw(bytes) => bytes, _ => return Err("PDFデータが不正です。".into()) };
    if !files.writable.lock().unwrap().contains(&p) { return Err("保存ダイアログで保存先を指定してください。".into()); }
    if let Ok(existing) = fs::canonicalize(&p) { if files.readable.lock().unwrap().contains(&existing) { return Err("読み込み済みのPDFとは異なる保存先を指定してください。".into()); } }
    if !data.starts_with(b"%PDF-") { return Err("PDFデータが不正です。".into()); }
    atomic_write(&p, data)?; files.readable.lock().unwrap().insert(fs::canonicalize(&p).map_err(|e| e.to_string())?); files.writable.lock().unwrap().remove(&p); Ok(())
}
#[tauri::command]
async fn confirm(app: tauri::AppHandle, window: WebviewWindow, message: String) -> bool {
    app.dialog().message(message).parent(&window).title("Folio PDF").buttons(MessageDialogButtons::OkCancel).blocking_show()
}
#[tauri::command]
async fn confirm_close(app: tauri::AppHandle, window: WebviewWindow, name: String) -> String {
    let result = app.dialog().message(format!("{name} の変更を保存しますか？")).parent(&window).title("Folio PDF")
        .buttons(MessageDialogButtons::YesNoCancelCustom("保存".into(),"破棄".into(),"キャンセル".into())).blocking_show_with_result();
    match result { MessageDialogResult::Yes => "save", MessageDialogResult::No => "discard", MessageDialogResult::Custom(ref s) if s == "保存" => "save", MessageDialogResult::Custom(ref s) if s == "破棄" => "discard", _ => "cancel" }.into()
}
#[tauri::command]
async fn external(app: tauri::AppHandle, url: String) -> Result<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) { return Err("HTTP(S)リンクのみ開けます。".into()); }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}
fn monitor(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let paths: Vec<_> = app.state::<Files>().watches.lock().unwrap().keys().cloned().collect();
        for (path, owner) in paths {
            let current = stamp(&path);
            let changed = { let files = app.state::<Files>(); let mut watches = files.watches.lock().unwrap();
                if let Some(watch) = watches.get_mut(&(path.clone(), owner)) { if current != watch.seen { watch.seen = current.clone(); if current != watch.baseline { Some(watch.doc_id.clone()) } else { None } } else { None } } else { None }
            };
            if let Some(doc_id) = changed { let _ = app.emit_to(runtime::label(owner), "folio-file-changed", json!({"id":doc_id,"missing":current.is_none()})); }
        }
    });
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(runtime::second_instance))
        .manage(Files::default()).manage(runtime::Runtime::default()).manage(printing::PrintJobs::default())
        .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init())
        .setup(|app| { runtime::initialize(app.handle()).map_err(std::io::Error::other)?; monitor(app.handle().clone()); Ok(()) })
        .on_webview_event(|webview, event| { if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
            let granted = runtime::grant_launch(webview.app_handle(), paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(), "");
            if granted.len() != paths.len() { let _ = webview.emit("folio-notice", "PDF以外のファイル、または読み取れないファイルを除外しました。"); }
            let _ = webview.emit("folio-drop", granted);
        } })
        .on_window_event(|window,event| { if matches!(event,tauri::WindowEvent::Destroyed) { runtime::destroyed(window.app_handle(),window.label()); printing::destroyed(window.app_handle(),window.label()); } })
        .invoke_handler(tauri::generate_handler![choose_files,read_pdf,watch_pdf,choose_destination,write_pdf,confirm,confirm_close,external,
            runtime::load_session,runtime::store_session,runtime::preferences,runtime::remember_pdf,runtime::list_windows,runtime::create_window,runtime::pending_paths,
            runtime::locate_pdf,runtime::claim_pdf,runtime::release_pdf,runtime::prepare_transfer,runtime::transfer_document,runtime::pending_transfers,runtime::read_transfer,runtime::acknowledge_transfer,runtime::cancel_transfer,
            printing::print_begin,printing::print_page,printing::print_end,printing::print_cancel,printing::print_payload,printing::read_print_page,printing::show_print])
        .run(tauri::generate_context!()).expect("Folio PDF could not start");
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn paths_must_be_absolute_pdfs() { assert!(pdf_path("relative.pdf").is_err()); assert!(pdf_path(&std::env::temp_dir().join("sample.PDF").to_string_lossy()).is_ok()); assert!(pdf_path(&std::env::temp_dir().join("sample.exe").to_string_lossy()).is_err()); }
    #[test] fn atomic_replace_keeps_complete_contents() { let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("sample.pdf"); atomic_write(&path,b"%PDF-old").unwrap(); atomic_write(&path,b"%PDF-new").unwrap(); assert_eq!(fs::read(path).unwrap(),b"%PDF-new"); }
    #[test] fn polling_detects_modification_and_deletion() { let dir = tempfile::tempdir().unwrap(); let p=dir.path().join("a.pdf"); fs::write(&p,b"old").unwrap(); let before=stamp(&p); fs::write(&p,b"new content").unwrap(); assert_ne!(before,stamp(&p)); fs::remove_file(&p).unwrap(); assert!(stamp(&p).is_none()); }
}
