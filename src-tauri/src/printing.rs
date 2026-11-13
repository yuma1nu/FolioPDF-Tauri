use crate::{Result, runtime};
use serde_json::{json,Value};
use std::{collections::HashMap,fs,sync::Mutex};
use tauri::{Manager,State,WebviewWindow};

struct Page { width:f64,height:f64 }
struct Job { owner:u32,dir:tempfile::TempDir,pages:Vec<Page>,title:String }
#[derive(Default)]
pub struct PrintJobs { jobs:Mutex<HashMap<String,Job>> }
#[tauri::command]
pub async fn print_begin(window:WebviewWindow,jobs:State<'_,PrintJobs>,title:String)->Result<String>{
    let token=uuid::Uuid::new_v4().to_string();
    jobs.jobs.lock().unwrap().insert(token.clone(),Job{owner:runtime::id(window.label())?,dir:tempfile::tempdir().map_err(|e|e.to_string())?,pages:vec![],title}); Ok(token)
}
#[tauri::command]
pub async fn print_page(window:WebviewWindow,jobs:State<'_,PrintJobs>,request:tauri::ipc::Request<'_>)->Result<()> {
    let meta:Value=serde_json::from_str(request.headers().get("folio-print").and_then(|v|v.to_str().ok()).ok_or("印刷情報がありません。")?).map_err(|e|e.to_string())?;
    let token=meta["job"].as_str().ok_or("ジョブがありません。")?;
    let mut jobs=jobs.jobs.lock().unwrap(); let job=jobs.get_mut(token).ok_or("印刷ジョブがありません。")?;
    if job.owner!=runtime::id(window.label())? {return Err("印刷元が異なります。".into());}
    let index=meta["index"].as_u64().ok_or("ページ番号が不正です。")? as usize;
    let width=meta["width"].as_f64().filter(|v|v.is_finite()&&*v>0.).ok_or("用紙幅が不正です。")?;
    let height=meta["height"].as_f64().filter(|v|v.is_finite()&&*v>0.).ok_or("用紙高が不正です。")?;
    if index!=job.pages.len(){return Err("ページ順が不正です。".into());}
    let data=match request.body(){tauri::ipc::InvokeBody::Raw(data)=>data,_=>return Err("印刷データが不正です。".into())};
    if !data.starts_with(b"\x89PNG\r\n\x1a\n") || data.len()>200_000_000 {return Err("印刷画像が不正です。".into());}
    fs::write(job.dir.path().join(format!("{index}.png")),data).map_err(|e|e.to_string())?; job.pages.push(Page{width,height}); Ok(())
}
#[tauri::command]
pub async fn print_end(app:tauri::AppHandle,window:WebviewWindow,jobs:State<'_,PrintJobs>,job:String)->Result<String>{
    {let jobs=jobs.jobs.lock().unwrap(); let item=jobs.get(&job).ok_or("印刷ジョブがありません。")?;
    if item.owner!=runtime::id(window.label())?||item.pages.is_empty(){return Err("印刷するページがありません。".into());}}
    tauri::WebviewWindowBuilder::new(&app,format!("print-{job}"),tauri::WebviewUrl::App("print.html".into()))
        .title("印刷 — Folio PDF").inner_size(900.,750.).build().map_err(|e|e.to_string())?;
    Ok("印刷用ウィンドウを開きました。用紙とプリンターを選択してください。".into())
}
#[tauri::command]
pub async fn print_cancel(app:tauri::AppHandle,window:WebviewWindow,jobs:State<'_,PrintJobs>,job:String)->Result<()> {
    let owner=runtime::id(window.label())?;
    {let mut jobs=jobs.jobs.lock().unwrap();if jobs.get(&job).is_some_and(|j|j.owner==owner){jobs.remove(&job);}else{return Err("印刷ジョブがありません。".into());}}
    if let Some(w)=app.get_webview_window(&format!("print-{job}")){let _=w.destroy();} Ok(())
}
fn token(window:&WebviewWindow)->Result<&str>{window.label().strip_prefix("print-").ok_or_else(||"印刷ウィンドウではありません。".into())}
#[tauri::command]
pub async fn print_payload(window:WebviewWindow,jobs:State<'_,PrintJobs>)->Result<Value>{
    let token=token(&window)?;let jobs=jobs.jobs.lock().unwrap();let job=jobs.get(token).ok_or("印刷ジョブがありません。")?;
    Ok(json!({"title":job.title,"pages":job.pages.iter().map(|p|json!({"width":p.width,"height":p.height})).collect::<Vec<_>>()}))
}
#[tauri::command]
pub async fn read_print_page(window:WebviewWindow,jobs:State<'_,PrintJobs>,index:usize)->Result<tauri::ipc::Response>{
    let token=token(&window)?;let jobs=jobs.jobs.lock().unwrap();let job=jobs.get(token).ok_or("印刷ジョブがありません。")?;
    if index>=job.pages.len(){return Err("印刷ページがありません。".into());} Ok(tauri::ipc::Response::new(fs::read(job.dir.path().join(format!("{index}.png"))).map_err(|e|e.to_string())?))
}
#[tauri::command]
pub async fn show_print(window:WebviewWindow)->Result<()> {
    token(&window)?;
    #[cfg(windows)] {
        use windows::core::Interface;
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_16,COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM};
        let (tx,rx)=tokio::sync::oneshot::channel();
        window.with_webview(move|webview|{let result=(||unsafe{let core=webview.controller().CoreWebView2()?.cast::<ICoreWebView2_16>()?;core.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)})();let _=tx.send(result.map_err(|e:windows::core::Error|e.to_string()));}).map_err(|e|e.to_string())?;
        rx.await.map_err(|e|e.to_string())?
    }
    #[cfg(not(windows))] {window.print().map_err(|e|e.to_string())}
}
pub fn destroyed(app:&tauri::AppHandle,label:&str){
    let state=app.state::<PrintJobs>();let mut jobs=state.jobs.lock().unwrap();
    if let Some(token)=label.strip_prefix("print-"){jobs.remove(token);}else if let Ok(owner)=runtime::id(label){
        jobs.retain(|token,j|j.owner!=owner||app.get_webview_window(&format!("print-{token}")).is_some());
    }
}
