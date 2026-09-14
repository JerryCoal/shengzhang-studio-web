import JSZip from 'jszip';

let pdfResources: Promise<JSZip> | undefined;
class LocalPDFResources {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const folder = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : '';
    if (!folder || !/^[A-Za-z0-9_.-]+$/.test(filename)) throw new Error('不支持的 PDF 字体资源');
    pdfResources ||= fetch(`${import.meta.env.BASE_URL}pdf-resources.zip`).then(response => { if (!response.ok) throw new Error('PDF 字体资源暂时无法读取，请刷新后重试'); return response.arrayBuffer(); }).then(data => JSZip.loadAsync(data)).catch(error => { pdfResources = undefined; throw error; });
    const resource = (await pdfResources).file(`${folder}/${filename}`);
    if (!resource) throw new Error('文档使用了暂不支持的字体映射');
    return resource.async('uint8array');
  }
}

export async function readDocument(file: File): Promise<{ text: string; format: 'txt' | 'md' | 'docx' | 'pdf' }> {
  if (file.size > 8 * 1024 * 1024) throw new Error('请选择 8 MB 以内的介绍文档');
  const format = file.name.split('.').at(-1)?.toLowerCase();
  let text = '';
  if (format === 'txt' || format === 'md') {
    const data = await file.arrayBuffer();
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { text = new TextDecoder('gb18030').decode(data); }
  } else if (format === 'docx') {
    const archive = await JSZip.loadAsync(file);
    const document = archive.file('word/document.xml');
    if (!document) throw new Error('这不是有效的 Word DOCX 文件');
    const expanded = (document as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof expanded !== 'number' || expanded > 4 * 1024 * 1024) throw new Error('文档正文过大，请拆分后导入');
    const xml = await document.async('string');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('文档包含不支持的 XML 声明');
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    if (dom.querySelector('parsererror')) throw new Error('文档结构损坏，请另存为 DOCX 后重试');
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    text = [...dom.getElementsByTagNameNS(namespace, 'p')].map(p => [...p.getElementsByTagNameNS(namespace, 't')].map(t => t.textContent || '').join('')).filter(Boolean).join('\n\n');
  } else if (format === 'pdf') {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, useWasm: false, useWorkerFetch: false, cMapUrl: 'local/', standardFontDataUrl: 'local/', BinaryDataFactory: LocalPDFResources, stopAtErrors: true });
    let passwordProtected = false;
    task.onPassword = () => { passwordProtected = true; void task.destroy(); };
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 100) throw new Error('请选择 100 页以内的 PDF，或拆分后导入');
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), content = await page.getTextContent();
        text += content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n\n';
        if (text.length > 300000) throw new Error('正文超过 30 万字，请拆分文档');
      }
    } catch (error) { if (passwordProtected) throw new Error('请先解除 PDF 阅读密码，再导入副本'); throw error; }
    finally { await task.destroy(); }
  } else throw new Error('支持 TXT、MD、DOCX 和文字型 PDF；旧版 DOC 请先另存为 DOCX');
  text = text.replace(/\u0000/g, '').trim();
  if (!text) throw new Error('未提取到正文；扫描件或图片型 PDF 请先转为文字');
  if (text.length > 300000) throw new Error('正文超过 30 万字，请拆分文档');
  return { text, format };
}
