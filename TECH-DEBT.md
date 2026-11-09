<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# 已知技术债（TECH-DEBT）

> 诚实地列出来，而不是藏起来。详细修复记录见内部 `PROJECT-STATE/OPEN-ITEMS`（不随公开树分发）。
> 本文件只谈产品可感知、尚未闭合的债，便于用户与贡献者对齐预期。

## 已闭合（留档防复发）
- 安装/卸载数据丢失与「停/卸不干净」：8 个代理卸载全保留 `.env`，账单先备份再删（bats 守卫）
- `lsof` 误报：绝对路径 + `/proc` 回退，双断言
- 门控状态条说谎：单一真源 `gates.js` + `/api/gates`，unknown 不降级成 negative
- 假入口（导出配置）：做真路由 + 按字段名脱敏

## 仍待闭合（公开可见）
- 核心网关 18790 单次转发，无 failover / 重试 / 熔断（仅 cursor-proxy 18794 与 opt-in 故障隔离提供）
- 编排引擎真实接管仍为影子默认（只记账不动路由）
- 部分 opt-in 能力（故障隔离 / 成本调度 / 告警）默认关，需显式开启
- 对外「能力默认态」说明此前缺失（本仓 `ROADMAP.md` 与 README「开箱默认态」提示即补此缺口）

## 我们不假装的事
- multi-proxy 不是通用 LLM 网关，不做云同步 / SaaS 多租户，不绑死供应商，开源版不含企业级 SSO / 分账。
- 「支持本地模型」不是差异卖点（LiteLLM / one-api 都做）；真正难抄的是用量归一、base_url 单一所有者、本地作为一档路由条件这三笔工程账。
