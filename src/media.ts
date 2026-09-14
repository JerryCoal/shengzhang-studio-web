import type { Asset, Project } from './types';
import { fileData } from './api';

const palettes = [ ['#dfe7d7', '#243e30', '#f5f1e4'], ['#ebe3d4', '#725744', '#f9f3e8'], ['#dce4e8', '#344f60', '#f1f5f5'] ];
function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
function wrapped(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineHeight: number, maxLines = 5) {
  const lines: string[] = []; let line = '';
  for (const char of text.replace(/\n+/g, ' ')) {
    if (ctx.measureText(line + char).width > width && line) { lines.push(line); line = char; } else line += char;
  }
  if (line) lines.push(line);
  lines.slice(0, maxLines).forEach((l, i) => ctx.fillText(i === maxLines - 1 && lines.length > maxLines ? l.slice(0, -1) + '…' : l, x, y + i * lineHeight));
}
async function loadImage(data: string) {
  if (!data) return null;
  return await new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('产品图片无法读取，请重新上传')); img.src = data; });
}
function product(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, brand: string, bg: string, ink: string) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); ctx.rotate(-0.08);
  ctx.fillStyle = '#00000014'; rounded(ctx, -80, 155, 205, 30, 20);
  ctx.fillStyle = bg; rounded(ctx, -100, -155, 195, 310, 9);
  ctx.fillStyle = ink; rounded(ctx, -100, -145, 195, 10, 0);
  ctx.fillStyle = ink; ctx.font = '600 28px sans-serif'; ctx.textAlign = 'center'; wrapped(ctx, brand, 0, -78, 170, 34, 2);
  ctx.lineWidth = 1.5; ctx.strokeStyle = ink;
  ctx.beginPath(); ctx.moveTo(-80, 70); ctx.lineTo(-45, 15); ctx.lineTo(-15, 46); ctx.lineTo(27, -5); ctx.lineTo(82, 70); ctx.stroke();
  ctx.font = '11px sans-serif'; ctx.fillText('A LITTLE MOMENT FOR YOU', 0, 112); ctx.restore();
}
function coverImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 28); ctx.clip();
  const ratio = Math.max(w / img.width, h / img.height); ctx.drawImage(img, x + (w - img.width * ratio) / 2, y + (h - img.height * ratio) / 2, img.width * ratio, img.height * ratio); ctx.restore();
}
export async function renderPoster(p: Project, asset: Asset, variant = 0) {
  p = { ...p, brief: p.strategies.find(s => s.id === asset.strategyId)?.briefSnapshot || p.brief };
  const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 1200;
  const ctx = canvas.getContext('2d')!; const [bg, ink, paper] = palettes[variant % palettes.length];
  const img = await loadImage(p.imageData);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 900, 1200);
  ctx.fillStyle = ink; ctx.font = '600 28px sans-serif'; ctx.fillText(p.brief.brand, 64, 83);
  ctx.font = '16px sans-serif'; ctx.fillText('EVERYDAY, A LITTLE BETTER.', 64, 115);
  ctx.font = '600 60px sans-serif'; wrapped(ctx, asset.title, 64, 227, 775, 83, 3);
  if (img) coverImage(ctx, img, 64, 460, 772, 500);
  else {
    ctx.fillStyle = paper; ctx.beginPath(); ctx.ellipse(485, 933, 385, 130, -0.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ink + '16'; ctx.beginPath(); ctx.arc(732, 688, 220, 0, Math.PI * 2); ctx.fill();
    product(ctx, 464, 733, 1.48, p.brief.brand, paper, ink);
  }
  ctx.fillStyle = ink; ctx.font = '26px sans-serif'; wrapped(ctx, asset.scenes[1], 64, 1042, 772, 40, 2);
  ctx.font = '16px sans-serif'; ctx.fillText(img ? p.brief.product : '品牌概念封面 · 可上传真实产品图重新制作', 64, 1150);
  return { mediaData: canvas.toDataURL('image/png'), mime: 'image/png' as const };
}
export async function renderVideo(p: Project, asset: Asset, onProgress: (percent: number) => void, signal: AbortSignal) {
  p = { ...p, brief: p.strategies.find(s => s.id === asset.strategyId)?.briefSnapshot || p.brief };
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('当前环境不支持视频合成，请在桌面 Chrome 或 Edge 中制作短片');
  const mime = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(x => MediaRecorder.isTypeSupported(x));
  if (!mime) throw new Error('当前浏览器缺少视频编码器，请使用桌面 Chrome 或 Edge');
  const canvas = document.createElement('canvas'); canvas.width = 540; canvas.height = 960;
  const ctx = canvas.getContext('2d')!; const img = await loadImage(p.imageData); const stream = canvas.captureStream(24);
  let audioContext: AudioContext | undefined, source: AudioBufferSourceNode | undefined;
  let animation = 0;
  try {
    if (p.audioData) {
      audioContext = new AudioContext(); await audioContext.resume();
      const data = await (await fetch(p.audioData)).arrayBuffer();
      const buffer = await audioContext.decodeAudioData(data);
      source = audioContext.createBufferSource(); source.buffer = buffer;
      const destination = audioContext.createMediaStreamDestination(); source.connect(destination);
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    }
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2200000 });
    const chunks: BlobPart[] = [];
    const blob = await new Promise<Blob>((resolve, reject) => {
      let completed = false; const start = performance.now();
      const abort = () => { if (recorder.state !== 'inactive') recorder.stop(); reject(new Error('已停止制作，已有成品保留')); };
      const visibility = () => { if (document.hidden) { if (recorder.state !== 'inactive') recorder.stop(); reject(new Error('视频制作需要保持页面可见，请返回页面后重试')); } };
      const cleanup = () => { signal.removeEventListener('abort', abort); document.removeEventListener('visibilitychange', visibility); };
      signal.addEventListener('abort', abort, { once: true }); document.addEventListener('visibilitychange', visibility);
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { cleanup(); reject(new Error('视频编码失败，请重试')); };
      recorder.onstop = () => { cleanup(); if (completed) resolve(new Blob(chunks, { type: mime.startsWith('video/mp4') ? 'video/mp4' : 'video/webm' })); };
      function draw() {
        const t = (performance.now() - start) / 1000;
        if (signal.aborted) return;
        const scene = Math.min(2, Math.floor(t / 4)); const [bg, ink, paper] = palettes[scene];
        ctx.fillStyle = bg; ctx.fillRect(0, 0, 540, 960);
        ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = '20px sans-serif'; ctx.fillText(p.brief.brand, 38, 62);
        ctx.font = '600 36px sans-serif'; wrapped(ctx, scene === 0 ? asset.title : asset.scenes[scene], 38, 155, 464, 51, 4);
        if (img) coverImage(ctx, img, 38, 367, 464, 358);
        else { ctx.fillStyle = paper; ctx.beginPath(); ctx.ellipse(278, 723, 262, 80, 0, 0, Math.PI * 2); ctx.fill(); product(ctx, 275, 554, 0.95 + (t % 4) * 0.025, p.brief.brand, paper, ink); }
        ctx.fillStyle = ink; ctx.font = '21px sans-serif'; wrapped(ctx, asset.scenes[scene], 38, 806, 464, 32, 3);
        ctx.fillStyle = ink + '30'; ctx.fillRect(38, 914, 464, 3); ctx.fillStyle = ink; ctx.fillRect(38, 914, 464 * Math.min(t / 12, 1), 3);
        onProgress(Math.round(Math.min(t / 12, 1) * 100));
        if (t >= 12) { completed = true; recorder.stop(); source?.stop(); } else animation = requestAnimationFrame(draw);
      }
      recorder.start(500); source?.start(); draw(); if (signal.aborted) abort();
    });
    return { mediaData: await fileData(blob), mime: blob.type as 'video/mp4' | 'video/webm' };
  } finally {
    cancelAnimationFrame(animation); stream.getTracks().forEach(t => t.stop());
    if (audioContext) await audioContext.close();
  }
}
