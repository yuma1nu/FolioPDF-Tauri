#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::{collections::HashSet, fs, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::{Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct Files { readable: Mutex<HashSet<PathBuf>>, writable: Mutex<HashSet<PathBuf>> }
type Result<T> = std::result::Result<T, String>;
fn pdf_path(path: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path);
    if !p.is_absolute() || !p.extension().is_some_and(|v| v.eq_ignore_ascii_case("pdf")) {
        return Err("PDFの絶対パスを指定してください。".into());
    }
    Ok(p)
}
fn state_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = match std::env::var_os("FOLIO_USER_DATA") {
        Some(dir) => { let dir = PathBuf::from(dir); if !dir.is_absolute() { return Err("FOLIO_USER_DATA must be absolute".into()); } dir },
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    Ok(dir.join("session.json"))
}
fn saved_paths(value: &Value) -> Vec<&str> {
    let mut paths = Vec::new();
    for key in ["tabs", "recent"] {
        if let Some(items) = value[key].as_array() {
            for item in items { if let Some(p) = item["path"].as_str() { paths.push(p); } }
        }
    }
    paths
}
fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("保存先が不正です。")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(data).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn choose_files(app: tauri::AppHandle, files: State<'_, Files>) -> Result<Vec<String>> {
    let chosen = app.dialog().file().add_filter("PDF", &["pdf"]).blocking_pick_files().unwrap_or_default();
    let mut paths = Vec::new();
    let mut readable = files.readable.lock().unwrap();
    for item in chosen {
        let p = item.into_path().map_err(|e| e.to_string())?;
        let p = fs::canonicalize(p).map_err(|e| e.to_string())?;
        pdf_path(&p.to_string_lossy())?;
        readable.insert(p.clone()); paths.push(p.to_string_lossy().into_owned());
    }
    Ok(paths)
}
#[tauri::command]
async fn read_pdf(path: String, files: State<'_, Files>) -> Result<tauri::ipc::Response> {
    let p = fs::canonicalize(pdf_path(&path)?).map_err(|e| e.to_string())?;
    if !files.readable.lock().unwrap().contains(&p) { return Err("先にファイル選択でPDFを開いてください。".into()); }
    Ok(tauri::ipc::Response::new(fs::read(p).map_err(|e| e.to_string())?))
}
#[tauri::command]
async fn choose_destination(app: tauri::AppHandle, files: State<'_, Files>, name: String) -> Result<Option<String>> {
    let chosen = app.dialog().file().add_filter("PDF", &["pdf"]).set_file_name(name).blocking_save_file();
    match chosen {
        None => Ok(None),
        Some(p) => {
            let mut p = p.into_path().map_err(|e| e.to_string())?;
            if !p.extension().is_some_and(|v| v.eq_ignore_ascii_case("pdf")) { p.set_extension("pdf"); }
            pdf_path(&p.to_string_lossy())?;
            files.writable.lock().unwrap().insert(p.clone());
            Ok(Some(p.to_string_lossy().into_owned()))
        }
    }
}
#[tauri::command]
async fn write_pdf(path: String, data: Vec<u8>, files: State<'_, Files>) -> Result<()> {
    let p = pdf_path(&path)?;
    if !files.writable.lock().unwrap().contains(&p) { return Err("保存ダイアログで保存先を指定してください。".into()); }
    if let Ok(existing) = fs::canonicalize(&p) {
        if files.readable.lock().unwrap().contains(&existing) { return Err("読み込み済みのPDFとは異なる保存先を指定してください。".into()); }
    }
    if !data.starts_with(b"%PDF-") { return Err("PDFデータが不正です。".into()); }
    atomic_write(&p, &data)?;
    files.readable.lock().unwrap().insert(fs::canonicalize(&p).map_err(|e| e.to_string())?);
    files.writable.lock().unwrap().remove(&p);
    Ok(())
}
#[tauri::command]
async fn load_session(app: tauri::AppHandle, files: State<'_, Files>) -> Result<Value> {
    let p = state_path(&app)?;
    let value: Value = match fs::read(&p) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("セッションを読み込めません: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(e.to_string()),
    };
    let mut readable = files.readable.lock().unwrap();
    for path in saved_paths(&value) {
        if let Ok(p) = pdf_path(path).and_then(|p| fs::canonicalize(p).map_err(|e| e.to_string())) { readable.insert(p); }
    }
    Ok(value)
}
#[tauri::command]
async fn store_session(app: tauri::AppHandle, files: State<'_, Files>, value: Value) -> Result<()> {
    for path in saved_paths(&value) {
        let p = pdf_path(path)?;
        if !p.exists() { continue; }
        let p = fs::canonicalize(p).map_err(|e| e.to_string())?;
        if !files.readable.lock().unwrap().contains(&p) { return Err("許可されていない履歴です。".into()); }
    }
    let p = state_path(&app)?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    atomic_write(&p, &serde_json::to_vec(&value).map_err(|e| e.to_string())?)
}
#[tauri::command]
async fn confirm(app: tauri::AppHandle, message: String) -> bool {
    app.dialog().message(message).title("Folio PDF · Tauri").buttons(MessageDialogButtons::OkCancel).blocking_show()
}
#[tauri::command]
async fn external(app: tauri::AppHandle, url: String) -> Result<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) { return Err("HTTP(S)リンクのみ開けます。".into()); }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}
fn main() {
    tauri::Builder::default()
        .manage(Files::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![choose_files, read_pdf, choose_destination, write_pdf, load_session, store_session, confirm, external])
        .run(tauri::generate_context!())
        .expect("Folio PDF could not start");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_must_be_absolute_pdfs() {
        assert!(pdf_path("relative.pdf").is_err());
        assert!(pdf_path(&std::env::temp_dir().join("sample.PDF").to_string_lossy()).is_ok());
        assert!(pdf_path(&std::env::temp_dir().join("sample.exe").to_string_lossy()).is_err());
    }
    #[test]
    fn atomic_replace_keeps_complete_contents() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("sample.pdf");
        atomic_write(&path, b"%PDF-old").unwrap(); atomic_write(&path, b"%PDF-new").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"%PDF-new");
    }
}
