// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// Provider 抽象接口
export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'deepseek' | 'generic';

export interface ModelInfo {
  id: string;
  name: string;
  providerId: ProviderId;
  enabled: boolean;
  alias?: string;
}

export interface UpstreamRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  [key: string]: any;
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  defaultBaseUrl: string;
  wireApi: 'openai' | 'anthropic' | 'gemini' | 'ollama';

  // 将 OpenAI 格式的请求转换为目标模型的格式
  normalizeRequest(chatRequest: any, config: ProviderConfig): Promise<UpstreamRequest>;

  // 将目标模型的响应转换为 OpenAI 格式
  denormalizeResponse(upstreamResponse: any, stream: boolean): Promise<any>;

  // 健康检查
  healthCheck(config: ProviderConfig): Promise<boolean>;

  // 获取可用模型列表
  fetchModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]>;

  // 支持工具调用？
  supportsTools(): boolean;

  // 支持视觉？
  supportsVision(): boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  providerId: ProviderId;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
}

/**
 * 给上游请求拼鉴权头。**api_key 为空就不发头**。
 *
 * 为什么不是无条件 `Bearer ${apiKey}`：有一类上游本来就不需要 key——
 * 本机 Ollama、LM Studio、vLLM，以及 Kilo 那种匿名免费池。对它们发一个空的
 * 或占位的 `Authorization: Bearer ...`，上游会当成"你给了个无效 token"
 * 直接 401（Kilo 明确回 `INVALID_TOKEN`），比不发更糟：看起来像 key 配错了，
 * 实际是这条上游根本不该发。
 *
 * 所以判断放在发请求这一层，而不是靠用户"记得留空"。
 */
export function bearerAuth(apiKey: string | null | undefined): Record<string, string> {
  const k = (apiKey ?? '').trim();
  return k ? { Authorization: `Bearer ${k}` } : {};
}
