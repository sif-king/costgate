// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// ==================== 门控「运行证据」层（2026-11-08） ====================
//
// 存在理由（对外交付判据 II「一眼可见」的缺口）：
// 门控状态条能回答「这一项在环境里是开还是关」，但「开着」有两种含义，
// 用户从状态条上分不出来：
//   (a) 开着，而且真的在跑（有可核对的落盘痕迹）
//   (b) 开着，但一次都没被走过（可能根本没接线、也可能是没人用）
// 两种都画绿色「已开启」⇒ (b) 被读成 (a)，正是「假功能」指控的同一种落差，
// 只是藏得更深一层。
//
// 本层只做一件事：给有真实落点的门控接上**可核对的数字**（几笔、几次、最近一次何时），
// 没有落点的项老实说「无运行证据」——不编、不推算、不拿默认值冒充。
//
// 三条不可退让的纪律：
//   ① **只读**。所有 provider 只 stat/read，不写盘、不改内存态。
//      尤其不能用 cost-track.loadLedger()（它会把历史账重新应用进 _state，看一眼前提是账翻倍）。
//   ② **「读不到」≠「零次」**。文件不存在 ⇒ 0 次（新装用户正常态）；读失败 ⇒ hits:null
//      + unknown:true。把 IO 失败报成 0 就是本层要消灭的那类谎。
//   ③ **没有采集点 ≠ 没在跑**。available:false 的项只说明我们采不到，不说明它没生效。
//
// 消费方：GET /api/gates 在每项上挂 `evidence` 字段；gatebar.js 渲染。

const os = require('os');
const path = require('path');
const costTrack = require('./cost-track');

// sandbox-egress 在仓库根的 packs/ 下，manager 只是它的消费方之一。
// require 失败不许让 /api/gates 整体挂掉（那样状态条会变成「读不到」，
// 等于用一个次要模块的缺失拖垮主信息），所以包一层。
let sandboxEgress = null;
try {
  sandboxEgress = require(path.join(__dirname, '..', '..', 'packs', 'sandbox-egress'));
} catch { sandboxEgress = null; }

// 家目录缩写：面板上显示绝对路径没人看，但路径又必须给出（否则「证据」不可核对）。
function tilde(p) {
  const home = os.homedir();
  if (typeof p !== 'string') return '';
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// ISO → 'MM-DD HH:mm'（本地时区）。只用于人读的 detail，原始值另给 lastAt 保留可核对性。
function fmtAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function miss(key, label, why) {
  return { key, label, available: true, hits: null, lastAt: null, unknown: true, source: '', unit: null, detail: why };
}

// ── provider：成本账本 ──
// 一笔账 = 一次真实入账。这是最硬的证据：它由热路径在真拿到 usage 之后才写。
function costLedger() {
  const label = '成本账本';
  let s;
  try {
    s = costTrack.ledgerStats();
  } catch (e) {
    return miss('cost-ledger', label, '账本统计异常：' + ((e && e.message) || '未知'));
  }
  const source = tilde(s.file);
  if (s.error) return { key: 'cost-ledger', label, available: true, hits: null, lastAt: null, unknown: true, source, unit: '笔', detail: '账本读不到：' + s.error };

  if (!s.exists || s.entries === 0) {
    return {
      key: 'cost-ledger', label, available: true, hits: 0, lastAt: null, unknown: false, source, unit: '笔',
      // 「0 笔」对成本记账来说有两种含义，必须都说出来：门控关着不落账，或真没人请求过。
      detail: '账本为空 · 没有入账记录（门控关闭时不落账；也可能是还没有请求走过）',
    };
  }
  const at = fmtAt(s.lastAt);
  return {
    key: 'cost-ledger', label, available: true, hits: s.entries, lastAt: s.lastAt, unknown: false, source, unit: '笔',
    detail: '已入账 ' + s.entries + ' 笔' + (at ? '，最近 ' + at : ''),
  };
}

// ── provider：出网脱敏命中（sandbox-egress 的 outbound-redact 记录）──
// 一条 = 脱敏**真的改写了**一次出网内容。0 条有两种原因（门控关 / 没命中敏感串），
// 面板必须都说，否则用户会把「没命中」读成「没生效」。
function egressOutbound() {
  const label = '出网脱敏命中';
  if (!sandboxEgress || typeof sandboxEgress.hitsStats !== 'function') {
    return miss('egress-outbound', label, 'sandbox-egress 模块不可用，采不到命中记录');
  }
  let s;
  try {
    s = sandboxEgress.hitsStats();
  } catch (e) {
    return miss('egress-outbound', label, '命中记录统计异常：' + ((e && e.message) || '未知'));
  }
  const source = tilde(s.file);
  if (s.error) return { key: 'egress-outbound', label, available: true, hits: null, lastAt: null, unknown: true, source, unit: '次', detail: '命中记录读不到：' + s.error };

  const n = (s.byKind && s.byKind['outbound-redact']) || 0;
  if (n === 0) {
    return {
      key: 'egress-outbound', label, available: true, hits: 0, lastAt: null, unknown: false, source, unit: '次',
      detail: '尚无命中 · 接线正常但从未遇到敏感串，或还没有请求出网（0 次≠没生效）',
    };
  }
  // 只取 outbound-redact 的最近时间不可得（hitsStats 给的是全文件最近），
  // 所以这里只报笔数，不报时间——报一个「全文件最近」会被误读成本类命中时间。
  return {
    key: 'egress-outbound', label, available: true, hits: n, lastAt: null, unknown: false, source, unit: '次',
    detail: '已改写 ' + n + ' 次出网内容',
  };
}

// ── provider：沙箱巡检（sandbox-egress 全部记录）──
// 回答的是另一个问题：这层巡检本身有没有在流量上跑过。
function egressAny() {
  const label = '沙箱巡检记录';
  if (!sandboxEgress || typeof sandboxEgress.hitsStats !== 'function') {
    return miss('egress-any', label, 'sandbox-egress 模块不可用，采不到巡检记录');
  }
  let s;
  try {
    s = sandboxEgress.hitsStats();
  } catch (e) {
    return miss('egress-any', label, '巡检记录统计异常：' + ((e && e.message) || '未知'));
  }
  const source = tilde(s.file);
  if (s.error) return { key: 'egress-any', label, available: true, hits: null, lastAt: null, unknown: true, source, unit: '次', detail: '巡检记录读不到：' + s.error };

  if (!s.total) {
    return {
      key: 'egress-any', label, available: true, hits: 0, lastAt: null, unknown: false, source, unit: '次',
      detail: '尚无记录 · 门控关闭时不记录；开着也只在命中时才写',
    };
  }
  const bd = s.byKind || {};
  const parts = Object.keys(bd).sort().map((k) => k + ' ' + bd[k]);
  return {
    key: 'egress-any', label, available: true, hits: s.total, lastAt: s.lastAt, unknown: false, source, unit: '次',
    detail: s.total + ' 条（' + parts.join(' / ') + '）',
  };
}

const PROVIDERS = {
  'cost-ledger': costLedger,
  'egress-outbound': egressOutbound,
  'egress-any': egressAny,
};

// 门控没有采集点时给的对象。available:false 只说明「我们采不到」，
// 绝不等于「没在跑」——面板文案必须照这个口径写。
function noCollector(key) {
  return {
    key: key || null,
    label: null,
    available: false,
    hits: null,
    lastAt: null,
    unknown: false,
    source: '',
    unit: null,
    detail: '无运行证据采集点（采不到 ≠ 没生效）',
  };
}

/**
 * 取某一项门控的运行证据。
 * @param {string|null} key  gates.js 里声明的 evidenceKey
 * @returns {{key,label,available,hits,lastAt,unknown,source,detail}}
 */
function forGate(key) {
  if (!key) return noCollector(null);
  const p = PROVIDERS[key];
  if (!p) return noCollector(key);
  try {
    return p();
  } catch (e) {
    // provider 自身抛错不许拖垮 /api/gates：降级成「读不到」，仍保留 available:true
    return miss(key, null, '证据采集失败：' + ((e && e.message) || '未知'));
  }
}

module.exports = { forGate, PROVIDERS, tilde, fmtAt };
