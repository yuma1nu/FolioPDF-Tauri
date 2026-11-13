import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';

const output = path.resolve('test-results', `native-${Date.now()}`); await mkdir(output, { recursive: true });
const sample = path.join(output, '図面 sample.pdf'), second = path.join(output, 'second.pdf');
async function makePdf(text, count = 3) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i=0;i<count;i++) pdf.addPage([595,842]).drawText(`${text} page ${i+1}`, { x:40,y:750,size:20,font });
  return pdf.save();
}
const original = await makePdf('NATIVE-TEST'); await writeFile(sample, original); await writeFile(second, await makePdf('SECOND-TEST',2));
const server = createServer(); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const port=server.address().port; await new Promise(resolve=>server.close(resolve));
const executable = path.resolve('src-tauri/target/release/folio-pdf.exe');
const env = { ...process.env,FOLIO_USER_DATA:output,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` };
let app,browser,context; const errors=[];
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const state = page => page.evaluate(()=>window.folio.snapshot());
async function poll(fn, timeout=30000) { const end=Date.now()+timeout; while(Date.now()<end){if(await fn())return;await sleep(100);}throw new Error(`Timed out: ${fn}`); }
const invoke = (page,command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
async function launch(args=[]) {
  app=spawn(executable,args,{windowsHide:true,stdio:'pipe',env});let error;app.on('error',e=>{error=e;});
  await poll(async()=>{if(error)throw error;if(app.exitCode!==null)throw new Error(`App exited (${app.exitCode}). Close any other running Folio PDF before testing.`);try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}});
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);context=browser.contexts()[0];
  for(const p of context.pages()) p.on('pageerror',e=>errors.push(e.message));context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  await poll(()=>context.pages().length>0);const page=context.pages()[0];await page.waitForSelector('.app');return page;
}
async function secondary(file){const child=spawn(executable,[file],{windowsHide:true,stdio:'pipe',env});await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Second instance exited ${code}`)));});}
async function killOwned(){await browser?.close().catch(()=>{});browser=undefined;if(app&&app.exitCode===null){const exited=new Promise(resolve=>app.once('exit',resolve));app.kill();await exited;}await sleep(300);}
const close = page => page.evaluate(()=>window.folio.closeWindow()).catch(e=>{if(!/closed|destroyed/i.test(String(e)))throw e;});
try {
  let main=await launch([sample]);
  await main.waitForSelector('.pdfViewer .page canvas');await poll(async()=>((await state(main)).docs[0]?.pages.length)===3);
  assert.equal(await main.title(),'Folio PDF');
  await main.getByRole('button',{name:'検索 (Ctrl+F)',exact:true}).click();await main.getByPlaceholder('検索する文字を入力').fill('NATIVE-TEST');
  await main.waitForFunction(()=>document.querySelector('.search-count')?.textContent.includes('3件'));
  await main.screenshot({path:path.join(output,'document.png')});
  await secondary(sample);await sleep(500);assert.equal((await state(main)).docs.length,1);
  await secondary(second);await poll(async()=>(await state(main)).docs.length===2);
  const sampleId=(await state(main)).docs.find(d=>d.name==='図面 sample.pdf').id;
  await main.evaluate(id=>window.folio.activate(id),sampleId);await main.waitForSelector('.pdfViewer .page canvas');
  await main.getByRole('button',{name:'ページ整理',exact:true}).click();await main.locator('.page-grid .thumbnail').first().click();
  await main.getByRole('button',{name:'右に90度回転',exact:true}).click();await poll(async()=>(await state(main)).docs.find(d=>d.id===sampleId).dirty);
  const before=(await state(main)).docs.find(d=>d.id===sampleId);
  const newPage=context.waitForEvent('page');const moving=main.evaluate(id=>window.folio.move(id),sampleId);
  const detached=await newPage;await detached.waitForSelector('.app');await moving;
  await poll(async()=>(await state(detached)).docs.length===1);
  const transferred=(await state(detached)).docs[0];assert.deepEqual(transferred.pages,before.pages);assert.equal(transferred.canUndo,true);assert.equal(transferred.ui.query,'NATIVE-TEST');assert.equal(transferred.ui.organize,true);
  await detached.evaluate(id=>window.folio.edit(id,{type:'undo'}),sampleId);assert.equal((await state(detached)).docs[0].pages[0].rotation,0);
  await detached.evaluate(id=>window.folio.edit(id,{type:'redo'}),sampleId);assert.equal((await state(detached)).docs[0].pages[0].rotation,90);
  await detached.evaluate(({id,owner})=>window.folio.move(id,owner),{id:sampleId,owner:(await state(main)).windowId});
  await poll(async()=>(await state(main)).docs.some(d=>d.id===sampleId));await close(detached);
  await assert.rejects(main.evaluate(id=>window.folio.move(id,99999),sampleId),/移動先/);assert.equal((await state(main)).docs.find(d=>d.id===sampleId).dirty,true);
  const changed=await makePdf('EXTERNALLY-CHANGED');await writeFile(sample,changed);
  await poll(async()=>(await state(main)).docs.find(d=>d.id===sampleId)?.changed);
  assert.deepEqual(await main.evaluate(async id=>Array.from(await window.folio.read(id)),sampleId),Array.from(original));
  await assert.rejects(main.evaluate(id=>window.folio.reload(id),sampleId),/保存/);
  await main.evaluate(id=>window.folio.close(id,true),sampleId);await main.evaluate(file=>window.folio.open([file]),sample);
  await poll(async()=>(await state(main)).docs.find(d=>d.name==='図面 sample.pdf')?.pages.length===3);
  let doc=(await state(main)).docs.find(d=>d.name==='図面 sample.pdf');
  await writeFile(sample,await makePdf('RELOADED',4));await poll(async()=>(await state(main)).docs.find(d=>d.id===doc.id)?.changed);
  await main.evaluate(id=>window.folio.reload(id),doc.id);await poll(async()=>(await state(main)).docs.find(d=>d.name==='図面 sample.pdf')?.pages.length===4);
  doc=(await state(main)).docs.find(d=>d.name==='図面 sample.pdf');assert.equal(doc.changed,undefined);
  // Native write permissions reject arbitrary paths, including raw binary IPC.
  assert.match(await main.evaluate(async bytes=>{try{await window.__TAURI_INTERNALS__.invoke('write_pdf',new Uint8Array(bytes),{headers:{'folio-path':JSON.stringify('C:\\unauthorized.pdf')}});return '';}catch(e){return String(e);}},Array.from(original)),/保存ダイアログ/);
  const secondId=(await state(main)).docs.find(d=>d.name==='second.pdf').id;await main.evaluate(id=>window.folio.close(id),secondId);
  await main.evaluate(()=>window.folio.settings({openMode:'window',theme:'dark'}));
  const another=context.waitForEvent('page');await secondary(second);const separate=await another;await separate.waitForSelector('.app');
  await poll(async()=>(await state(separate)).docs[0]?.pages.length===2);assert.equal((await state(separate)).settings.theme,'dark');
  await main.evaluate(()=>window.folio.settings({theme:'light'}));await separate.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  // Prepare the actual print window and export it through CDP, without sending to a printer.
  const printPagePromise=context.waitForEvent('page');await main.getByRole('button',{name:'印刷 (Ctrl+P)',exact:true}).click();const printing=await printPagePromise;
  await printing.waitForFunction(()=>document.querySelector('#print')?.disabled===false,null,{timeout:60000});assert.equal(await printing.locator('section').count(),4);
  const cdp=await context.newCDPSession(printing);const printed=await cdp.send('Page.printToPDF',{preferCSSPageSize:true,printBackground:true});
  const printedBytes=Buffer.from(printed.data,'base64');await writeFile(path.join(output,'print-output.pdf'),printedBytes);const printedPdf=await PDFDocument.load(printedBytes);
  assert.equal(printedPdf.getPageCount(),4);assert.ok(Math.abs(printedPdf.getPage(0).getWidth()-595)<1);
  if(process.argv.includes('--inspect-print')){
    console.log(`PRINT_DIALOG_CHECK: ${path.join(output,'continue')}`);
    await Promise.race([invoke(printing,'show_print'),sleep(120000).then(()=>{throw new Error('Print dialog inspection timed out; run this check with the desktop unlocked.');})]);
    await poll(async()=>{try{await readFile(path.join(output,'continue'));return true;}catch{return false;}},300000);
  }
  await printing.screenshot({path:path.join(output,'print-preview.png')});await invoke(printing,'plugin:window|close',{label:await printing.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)}).catch(()=>{});
  await sleep(900);let saved=JSON.parse(await readFile(path.join(output,'session.json'),'utf8'));assert.equal(Object.keys(saved.windows).length,2);
  assert.ok(Object.values(saved.windows).every(w=>w.bounds.width>0&&w.bounds.height>0));
  await main.screenshot({path:path.join(output,'main-window.png')});await separate.screenshot({path:path.join(output,'second-window.png')});
  await killOwned();
  saved=JSON.parse(await readFile(path.join(output,'session.json'),'utf8'));
  const expectedWidth=Math.floor(saved.windows['1'].bounds.width*0.9),expectedHeight=Math.floor(saved.windows['1'].bounds.height*0.9);
  Object.assign(saved.windows['1'].bounds,{width:expectedWidth,height:expectedHeight,maximized:false});await writeFile(path.join(output,'session.json'),JSON.stringify(saved));
  main=await launch();await poll(()=>context.pages().length===2);
  await poll(async()=>{const states=await Promise.all(context.pages().map(state));return states.every(s=>s.docs.length===1)&&states.some(s=>s.docs[0].name==='図面 sample.pdf')&&states.some(s=>s.docs[0].name==='second.pdf');});
  const restored=context.pages();main=restored.find(p=>p===main)??restored[0];for(const p of restored){assert.equal((await state(p)).settings.theme,'light');}
  const restoredEntries=await Promise.all(restored.map(async page=>({page,snapshot:await state(page)})));
  const restoredMain=restoredEntries.find(entry=>entry.snapshot.windowId===1).page;
  const restoredSize=await invoke(restoredMain,'plugin:window|inner_size',{label:'main'});assert.equal(restoredSize.width,expectedWidth);assert.equal(restoredSize.height,expectedHeight);
  await main.evaluate(()=>window.folio.settings({restore:false}));for(const p of [...restored].filter(p=>p!==main))await close(p);await close(main);await killOwned();
  main=await launch();await main.waitForSelector('.home');assert.equal((await state(main)).docs.length,0);assert.equal(context.pages().length,1);await close(main);await killOwned();
  await writeFile(path.join(output,'session.json'),'{broken JSON');main=await launch();await main.waitForSelector('.home');
  assert.ok((await readdir(output)).some(name=>name.startsWith('session.corrupt-')));assert.equal((await state(main)).settings.theme,'system');await close(main);
  assert.deepEqual(errors,[]);
  console.log(`NATIVE PASS: CLI/single instance, duplicate activation, multi-window move/undo/redo, external changes/reload, binary write permissions, shared settings, print PDF output, multi-window restore and restore opt-out. Artifacts: ${output}`);
} catch(error) {
  if(context)for(const [i,p]of context.pages().entries())if(!p.isClosed()){await p.screenshot({path:path.join(output,`failure-${i}.png`)}).catch(()=>{});console.error(p.url(),await p.locator('body').innerText().catch(()=>''));}
  throw error;
} finally {await killOwned();}
