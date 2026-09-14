import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { atomicJSON } from './vault.mjs';
export const MODELS = {
  'gpt-5.4': { label: 'GPT-5.4', inputPrice: 2.5, outputPrice: 15, description: '适合复杂策划、约束协调和迭代判断' },
  'gpt-5.4-mini': { label: 'GPT-5.4 mini', inputPrice: 0.75, outputPrice: 4.5, description: '平衡内容质量、速度和费用' },
  'gpt-5.4-nano': { label: 'GPT-5.4 nano', inputPrice: 0.2, outputPrice: 1.25, description: '适合标签、情绪等简单结构化任务' },
};
export const STAGES = [
  { id: 'strategy', label: '宣传策略', model: 'gpt-5.4', effort: 'medium', maxTokens: 4500, reason: '同时考虑品牌、受众、渠道与事实约束，优先保证方向质量。' },
  { id: 'planning', label: '下期策划', model: 'gpt-5.4', effort: 'medium', maxTokens: 4500, reason: '结合已采用的反馈重新规划，需要更强的综合判断。' },
  { id: 'copy', label: '文案与分镜', model: 'gpt-5.4-mini', effort: 'low', maxTokens: 3500, reason: '在已确认策略内写标题、正文和分镜，兼顾质量与响应速度。' },
  { id: 'classification', label: '评论标签与情绪', model: 'gpt-5.4-nano', effort: 'low', maxTokens: 7000, reason: '固定类别的批量识别使用小模型；保留人工校正。' },
  { id: 'analysis', label: '评论复盘', model: 'gpt-5.4-mini', effort: 'medium', maxTokens: 4500, reason: '从评论中提取观察、原文依据与可验证建议。' },
];
export const DEFAULT_ROUTES = Object.fromEntries(STAGES.map(s => [s.id, s.model]));
export const routesSchema = z.object(Object.fromEntries(STAGES.map(s => [s.id, z.enum(Object.keys(MODELS))]))).strict();
export function createModelStore(file) {
  let routes = { ...DEFAULT_ROUTES };
  if (file) { try { routes = routesSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw new Error('模型配置文件无效，请检查 model-settings.json'); } }
  return { get: () => ({ ...routes }), save(value) { const next = routesSchema.parse(value); if (file) atomicJSON(file, next); routes = next; return this.get(); } };
}
export function stageConfig(stage, routes) { const definition = STAGES.find(s => s.id === stage); const model = routes[stage]; return { ...definition, model, ...MODELS[model] }; }
