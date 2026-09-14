import JSZip from 'jszip';
import { Capacitor } from '@capacitor/core';
import { api, API_BASE, download, LOCAL_DATA } from './api';
import type { Asset, Publication } from './types';
export async function exportContent(content: Asset | Publication, projectId: string) {
  if (!content.mediaData) throw new Error('请先制作素材');
  if (!LOCAL_DATA && !Capacitor.isNativePlatform()) {
    const result = await api<{ url: string; filename: string }>(`/projects/${projectId}/export`, 'POST', { kind: 'platform' in content ? 'publication' : 'asset', id: content.id });
    download(`${API_BASE}${result.url}`, result.filename);
    return;
  }
  const zip = new JSZip();
  const extension = content.mime === 'image/png' ? 'png' : content.mime === 'video/mp4' ? 'mp4' : 'webm';
  zip.file(`素材.${extension}`, content.mediaData.split(',')[1], { base64: true });
  zip.file('标题与正文.txt', `${content.title}\n\n${content.body}`);
  zip.file('发布说明.txt', `此素材包由生长运营工作台导出，尚未发布。\n请检查内容与产品事实，在对应平台选择素材并发布。\n发布成功后，将真实作品链接回填到发布中心。\n${extension === 'webm' ? '视频为 WebM 格式。若发布平台不接受，请先转为 MP4。\n' : ''}`);
  const filename = `${content.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '宣传内容'}-素材包.zip`;
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    const { uri } = await Filesystem.writeFile({ path: `exports/${Date.now()}-${filename}`, data: await zip.generateAsync({ type: 'base64' }), directory: Directory.Cache, recursive: true });
    await Share.share({ title: content.title, files: [uri] });
  } else download(await zip.generateAsync({ type: 'blob' }), filename);
}
