use crate::Result;
use serde::Serialize;
use std::{fs::File, io::BufReader, mem::size_of, path::Path, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use windows::{core::{PCWSTR, PWSTR, BOOL}, Win32::{Foundation::HWND, Graphics::{Gdi::*, Printing::*}, Storage::Xps::*, System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED}}};

fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
fn failure(action: &str) -> String { format!("{action}: {}", windows::core::Error::from_thread()) }

// DEVMODE includes opaque driver-private data. Keep the entire, properly aligned buffer.
#[derive(Clone)]
struct Buffer { words: Vec<usize>, length: usize }
impl Buffer {
    fn new(length: usize) -> Result<Self> {
        if length == 0 || length > 16 * 1024 * 1024 { return Err("ドライバーの設定サイズが不正です。".into()); }
        Ok(Self { words: vec![0; length.div_ceil(size_of::<usize>())], length })
    }
    fn bytes_mut(&mut self) -> &mut [u8] { unsafe { std::slice::from_raw_parts_mut(self.words.as_mut_ptr().cast(), self.length) } }
    fn mode(&self) -> *const DEVMODEW { self.words.as_ptr().cast() }
    fn mode_mut(&mut self) -> *mut DEVMODEW { self.words.as_mut_ptr().cast() }
    fn validate_mode(&self) -> Result<()> {
        if self.length < size_of::<DEVMODEW>() { return Err("ドライバーの設定データが不足しています。".into()); }
        let mode = unsafe { &*self.mode() };
        if (mode.dmSize as usize) < size_of::<DEVMODEW>() || mode.dmSize as usize + mode.dmDriverExtra as usize > self.length {
            return Err("ドライバーの設定データが不正です。".into());
        }
        Ok(())
    }
}

struct Printer(PRINTER_HANDLE);
impl Printer {
    fn open(name: &[u16]) -> Result<Self> {
        let mut handle = PRINTER_HANDLE::default();
        unsafe { OpenPrinterW(PCWSTR(name.as_ptr()), &mut handle, None) }.map_err(|e| format!("プリンターを開けません: {e}"))?;
        Ok(Self(handle))
    }
}
impl Drop for Printer { fn drop(&mut self) { let _ = unsafe { ClosePrinter(self.0) }; } }

#[derive(Clone)]
pub struct Settings { pub name: String, mode: Buffer }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterList { pub printers: Vec<String>, pub default_printer: Option<String> }

pub fn list() -> Result<PrinterList> {
    let mut needed = 0u32; let mut returned = 0u32;
    unsafe { let _ = EnumPrintersW(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, PCWSTR::null(), 4, None, &mut needed, &mut returned); }
    let mut printers = Vec::new();
    if needed > 0 {
        let mut buffer = Buffer::new(needed as usize)?;
        unsafe { EnumPrintersW(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, PCWSTR::null(), 4, Some(buffer.bytes_mut()), &mut needed, &mut returned) }.map_err(|e| format!("プリンター一覧を取得できません: {e}"))?;
        if returned as usize > buffer.length / size_of::<PRINTER_INFO_4W>() { return Err("プリンター一覧が不正です。".into()); }
        for info in unsafe { std::slice::from_raw_parts(buffer.words.as_ptr().cast::<PRINTER_INFO_4W>(), returned as usize) } {
            if !info.pPrinterName.is_null() { printers.push(unsafe { info.pPrinterName.to_string() }.map_err(|e| e.to_string())?); }
        }
    }
    printers.sort_by_key(|s| s.to_lowercase()); printers.dedup();
    let mut count = 0u32; unsafe { let _ = GetDefaultPrinterW(None, &mut count); }
    let default_printer = if count > 0 && count < 32768 {
        let mut name = vec![0u16; count as usize];
        if unsafe { GetDefaultPrinterW(Some(PWSTR(name.as_mut_ptr())), &mut count) }.as_bool() {
            let name = String::from_utf16_lossy(&name[..name.iter().position(|v| *v == 0).unwrap_or(name.len())]);
            printers.iter().find(|p| **p == name).cloned()
        } else { None }
    } else { None };
    Ok(PrinterList { printers, default_printer })
}

impl Settings {
    pub fn load(name: String) -> Result<Self> {
        if !list()?.printers.contains(&name) { return Err("インストール済みのプリンターを選択してください。".into()); }
        let device = wide(&name); let printer = Printer::open(&device)?;
        let required = unsafe { DocumentPropertiesW(None, printer.0, PCWSTR(device.as_ptr()), None, None, 0) };
        if required < size_of::<DEVMODEW>() as i32 { return Err("プリンタードライバーの設定を取得できません。".into()); }
        let mut mode = Buffer::new(required as usize)?;
        let result = unsafe { DocumentPropertiesW(None, printer.0, PCWSTR(device.as_ptr()), Some(mode.mode_mut()), None, DM_OUT_BUFFER.0) };
        if result != 1 { return Err(failure("ドライバーの設定を取得できません")); }
        mode.validate_mode()?;
        Ok(Self { name, mode })
    }
    pub fn properties(&self, owner: usize) -> Result<Option<Self>> {
        // Run on a dedicated STA thread. No global printer defaults are changed.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok().map_err(|e| e.to_string())?;
        struct Com; impl Drop for Com { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
        let _com = Com;
        let name = wide(&self.name); let printer = Printer::open(&name)?;
        let mut output = self.mode.clone();
        let result = unsafe { DocumentPropertiesW(Some(HWND(owner as *mut _)), printer.0, PCWSTR(name.as_ptr()), Some(output.mode_mut()), Some(self.mode.mode()), (DM_IN_BUFFER | DM_OUT_BUFFER | DM_IN_PROMPT).0) };
        match result {
            1 => { output.validate_mode()?; Ok(Some(Self { name: self.name.clone(), mode: output })) },
            2 => Ok(None),
            _ => Err(failure("ドライバーの設定画面を開けません")),
        }
    }
}

pub struct SpoolPage { pub path: std::path::PathBuf, pub width: f64, pub height: f64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt { pub printer: String, pub job_id: i32, pub pages: usize }
struct Dc(HDC);
impl Drop for Dc { fn drop(&mut self) { unsafe { let _ = DeleteDC(self.0); } } }
struct Document { dc: HDC, complete: bool }
impl Drop for Document { fn drop(&mut self) { if !self.complete { unsafe { AbortDoc(self.dc); } } } }
thread_local! { static CANCEL: std::cell::RefCell<Option<Arc<AtomicBool>>> = const { std::cell::RefCell::new(None) }; }
unsafe extern "system" fn abort_proc(_: HDC, _: i32) -> BOOL {
    BOOL::from(!CANCEL.with(|c| c.borrow().as_ref().is_some_and(|c| c.load(Ordering::Relaxed))))
}

#[derive(Debug, PartialEq)]
struct Placement { x: i32, y: i32, width: i32, height: i32 }
fn placement(page_width: f64, page_height: f64, area_width: i32, area_height: i32, dpi_x: i32, dpi_y: i32, fit: bool) -> Result<Placement> {
    if !page_width.is_finite() || !page_height.is_finite() || page_width <= 0. || page_height <= 0. || [area_width, area_height, dpi_x, dpi_y].iter().any(|&v| v <= 0) {
        return Err("用紙サイズまたはプリンターの解像度が不正です。".into());
    }
    let width = page_width * dpi_x as f64 / 72.; let height = page_height * dpi_y as f64 / 72.;
    let scale = if fit { (area_width as f64 / width).min(area_height as f64 / height) } else { 1. };
    let w = (width * scale).round(); let h = (height * scale).round();
    if w > i32::MAX as f64 || h > i32::MAX as f64 || w < 1. || h < 1. { return Err("印刷サイズが大きすぎます。".into()); }
    let width = w as i32; let height = h as i32;
    Ok(Placement { x: (area_width - width) / 2, y: (area_height - height) / 2, width, height })
}

struct Bitmap { width: u32, height: u32, pixels: Vec<u8> }
fn read_bitmap(path: &Path) -> Result<Bitmap> {
    let mut decoder = png::Decoder::new(BufReader::new(File::open(path).map_err(|e| e.to_string())?));
    decoder.set_limits(png::Limits { bytes: 200_000_000 });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let (width, height) = (reader.info().width, reader.info().height);
    if width == 0 || height == 0 || width > 8192 || height > 8192 || width as u64 * height as u64 > 24_020_000 { return Err("印刷画像のサイズが不正です。".into()); }
    let mut decoded = vec![0u8; reader.output_buffer_size().ok_or("画像が大きすぎます。")?];
    let info = reader.next_frame(&mut decoded).map_err(|e| e.to_string())?;
    if info.bit_depth != png::BitDepth::Eight { return Err("印刷画像の色形式が未対応です。".into()); }
    let channels = match info.color_type { png::ColorType::Rgba => 4, png::ColorType::Rgb => 3, png::ColorType::GrayscaleAlpha => 2, png::ColorType::Grayscale => 1, _ => return Err("印刷画像の色形式が未対応です。".into()) };
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    for pixel in decoded[..info.buffer_size()].chunks_exact(channels) {
        let (r, g, b, a) = match channels { 4 => (pixel[0],pixel[1],pixel[2],pixel[3]), 3 => (pixel[0],pixel[1],pixel[2],255), 2 => (pixel[0],pixel[0],pixel[0],pixel[1]), _ => (pixel[0],pixel[0],pixel[0],255) };
        let white = |v: u8| ((v as u32 * a as u32 + 255 * (255 - a as u32) + 127) / 255) as u8;
        pixels.extend_from_slice(&[white(b), white(g), white(r), 0]);
    }
    Ok(Bitmap { width, height, pixels })
}

fn draw(dc: HDC, bitmap: &Bitmap, target: &Placement) -> Result<()> {
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER { biSize: size_of::<BITMAPINFOHEADER>() as u32, biWidth: bitmap.width as i32, biHeight: -(bitmap.height as i32), biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() };
    let result = unsafe { SetStretchBltMode(dc, HALFTONE); StretchDIBits(dc, target.x, target.y, target.width, target.height, 0, 0, bitmap.width as i32, bitmap.height as i32, Some(bitmap.pixels.as_ptr().cast()), &info, DIB_RGB_COLORS, SRCCOPY) };
    if result == 0 || result == GDI_ERROR { return Err(failure("印刷画像をプリンターへ転送できません")); }
    Ok(())
}

pub fn submit(settings: Settings, title: String, pages: Vec<SpoolPage>, fit: bool, cancelled: Arc<AtomicBool>) -> Result<Receipt> {
    settings.mode.validate_mode()?;
    let driver = wide("WINSPOOL"); let device = wide(&settings.name); let title = wide(&title);
    let dc = Dc(unsafe { CreateDCW(PCWSTR(driver.as_ptr()), PCWSTR(device.as_ptr()), PCWSTR::null(), Some(settings.mode.mode())) });
    if dc.0.is_invalid() { return Err(failure("プリンターを初期化できません")); }
    let check = || if cancelled.load(Ordering::Relaxed) { Err("プリンターへの送信をキャンセルしました。".to_string()) } else { Ok(()) };
    check()?;
    CANCEL.with(|c| *c.borrow_mut() = Some(cancelled.clone()));
    struct CancelScope; impl Drop for CancelScope { fn drop(&mut self) { CANCEL.with(|c| *c.borrow_mut() = None); } }
    let _scope = CancelScope;
    if unsafe { SetAbortProc(dc.0, Some(abort_proc)) } <= 0 { return Err(failure("印刷の中止処理を初期化できません")); }
    let info = DOCINFOW { cbSize: size_of::<DOCINFOW>() as i32, lpszDocName: PCWSTR(title.as_ptr()), ..Default::default() };
    let job_id = unsafe { StartDocW(dc.0, &info) };
    if job_id <= 0 { return Err(failure("プリンターへの送信を開始できません")); }
    let mut document = Document { dc: dc.0, complete: false };
    for page in &pages {
        check()?;
        let bitmap = read_bitmap(&page.path)?;
        if unsafe { StartPage(dc.0) } <= 0 { return Err(failure("印刷ページを開始できません")); }
        let target = placement(page.width, page.height, unsafe { GetDeviceCaps(Some(dc.0), HORZRES) }, unsafe { GetDeviceCaps(Some(dc.0), VERTRES) }, unsafe { GetDeviceCaps(Some(dc.0), LOGPIXELSX) }, unsafe { GetDeviceCaps(Some(dc.0), LOGPIXELSY) }, fit)?;
        draw(dc.0, &bitmap, &target)?; check()?;
        if unsafe { EndPage(dc.0) } <= 0 { return Err(failure("印刷ページを送信できません")); }
    }
    check()?;
    if unsafe { EndDoc(dc.0) } <= 0 { return Err(failure("印刷データの送信を完了できません")); }
    document.complete = true;
    Ok(Receipt { printer: settings.name, job_id, pages: pages.len() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fit_and_actual_size_use_printer_dpi_and_centering() {
        assert_eq!(placement(720.,360.,1000,1000,100,100,true).unwrap(), Placement{x:0,y:250,width:1000,height:500});
        assert_eq!(placement(72.,72.,1000,1000,300,600,false).unwrap(), Placement{x:350,y:200,width:300,height:600});
        assert_eq!(placement(1440.,720.,1000,1000,100,100,false).unwrap(), Placement{x:-500,y:0,width:2000,height:1000});
        assert!(placement(0.,72.,1000,1000,100,100,true).is_err());
    }
    #[test]
    fn png_alpha_is_composited_on_white_and_converted_to_top_down_bgr() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("test.png");
        let mut encoder=png::Encoder::new(File::create(&path).unwrap(),2,1);encoder.set_color(png::ColorType::Rgba);encoder.set_depth(png::BitDepth::Eight);
        let mut writer=encoder.write_header().unwrap();writer.write_image_data(&[255,0,0,255,0,0,255,0]).unwrap();drop(writer);
        let bitmap=read_bitmap(&path).unwrap();assert_eq!(bitmap.pixels,vec![0,0,255,0,255,255,255,0]);
    }
    #[test]
    fn private_devmode_bytes_survive_cloning() {
        let mut buffer=Buffer::new(size_of::<DEVMODEW>()+64).unwrap();unsafe{(*buffer.mode_mut()).dmSize=size_of::<DEVMODEW>() as u16;(*buffer.mode_mut()).dmDriverExtra=64;}
        buffer.bytes_mut()[size_of::<DEVMODEW>()..].fill(0x5a);let mut clone=buffer.clone();clone.validate_mode().unwrap();assert_eq!(buffer.bytes_mut(),clone.bytes_mut());
    }
    #[test]
    fn gdi_drawing_uses_the_expected_pixel_channels_without_a_printer() {
        unsafe {
            let dc=Dc(CreateCompatibleDC(None));assert!(!dc.0.is_invalid());let mut info=BITMAPINFO::default();info.bmiHeader=BITMAPINFOHEADER{biSize:size_of::<BITMAPINFOHEADER>() as u32,biWidth:1,biHeight:-1,biPlanes:1,biBitCount:32,biCompression:BI_RGB.0,..Default::default()};
            let mut bits=std::ptr::null_mut();let bitmap=CreateDIBSection(Some(dc.0),&info,DIB_RGB_COLORS,&mut bits,None,0).unwrap();let old=SelectObject(dc.0,HGDIOBJ(bitmap.0));
            draw(dc.0,&Bitmap{width:1,height:1,pixels:vec![0,0,255,0]},&Placement{x:0,y:0,width:1,height:1}).unwrap();assert_eq!(GetPixel(dc.0,0,0).0,0x0000ff);
            SelectObject(dc.0,old);let _=DeleteObject(HGDIOBJ(bitmap.0));
        }
    }
    #[test]
    fn installed_virtual_printer_settings_can_be_read_without_submitting_a_job() {
        let printers=list().unwrap();if let Some(name)=printers.printers.into_iter().find(|n|n=="Microsoft Print to PDF"){let settings=Settings::load(name).unwrap();settings.mode.validate_mode().unwrap();}
    }
}
