import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import type { PdfTask } from './pdf-work';
const signed = (pdf: PDFDocument) => pdf.getForm().getFields().some(f => f.acroField.dict.get(PDFName.of('FT')) === PDFName.of('Sig'));
async function run(task: PdfTask) {
  if (task.type === 'inspect') {
    try {
      const pdf = await PDFDocument.load(task.bytes, { updateMetadata: false });
      return { encrypted: false, signed: signed(pdf), complex: pdf.getForm().getFields().length > 0 || !!pdf.catalog.get(PDFName.of('Outlines')) || pdf.getPages().some(p => !!p.node.get(PDFName.of('Annots'))), unsupported: false };
    } catch (e) { return { encrypted: /encrypt/i.test(String(e)), signed: false, complex: true, unsupported: !/encrypt/i.test(String(e)) }; }
  }
  const output = await PDFDocument.create();
  if (task.type === 'merge') {
    for (const bytes of task.sources) {
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      if (signed(source)) throw new Error('署名付きPDFの結合には対応していません。');
      for (const page of await output.copyPages(source, source.getPageIndices())) output.addPage(page);
    }
  } else {
    const source = await PDFDocument.load(task.bytes, { updateMetadata: false });
    (await output.copyPages(source, task.pages.map(p => p.source))).forEach((p, i) => { p.setRotation(degrees(task.pages[i].rotation)); output.addPage(p); });
  }
  return output.save();
}
self.onmessage = ({ data }: MessageEvent<PdfTask>) => { void run(data).then(result => self.postMessage({ result })).catch(e => self.postMessage({ error: String(e.message ?? e) })); };
