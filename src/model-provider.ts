import type { Settings, Stage, TextProvider } from './types';
export const providerLabel = (provider: TextProvider) => provider === 'deepseek' ? 'DeepSeek' : 'OpenAI';
export const stageProvider = (settings: Settings, stage: Stage): TextProvider => settings.models[settings.routes[stage]]?.provider || 'openai';
export const canGenerate = (settings: Settings, stage: Stage) => {
  const provider = stageProvider(settings, stage);
  return settings.providers?.[provider]?.configured ?? (provider === 'openai' && settings.openaiConfigured);
};
