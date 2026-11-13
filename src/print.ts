import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './print.css';
const status = document.querySelector<HTMLElement>('#status')!, button = document.querySelector<HTMLButtonElement>('#print')!;
document.querySelector('#close')!.addEventListener('click', () => { void getCurrentWindow().close(); });
button.addEventListener('click', () => { void invoke('show_print').catch(e => { status.textContent = String(e); }); });
const urls: string[] = [];
window.addEventListener('unload', () => urls.forEach(url => URL.revokeObjectURL(url)));
void (async () => {
  const payload = await invoke<{ title: string; pages: { width: number; height: number }[] }>('print_payload');
  document.querySelector('#title')!.textContent = `${payload.title} · ${payload.pages.length}ページ`;
  const style = document.createElement('style');
  style.textContent = payload.pages.map((p,i) => `@page p${i}{size:${p.width}pt ${p.height}pt;margin:0} @media print{.p${i}{page:p${i};width:${p.width}pt;height:${p.height}pt}}`).join(''); document.head.append(style);
  for (const [index, p] of payload.pages.entries()) {
    const bytes = await invoke<ArrayBuffer>('read_print_page', { index });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' })); urls.push(url);
    const section = document.createElement('section'), image = document.createElement('img');
    section.className = `p${index}`; section.style.aspectRatio = `${p.width}/${p.height}`; image.src = url; image.alt = `${index + 1}ページ`;
    await image.decode(); section.append(image); document.querySelector('#pages')!.append(section);
  }
  button.disabled = false; status.textContent = '用紙・倍率・両面印刷は印刷ダイアログで指定してください。';
})().catch(e => { status.textContent = `印刷を準備できませんでした: ${e}`; });
