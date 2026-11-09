// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * self-ports.test.js — 「自家端口」清单与真源对拍
 *
 * 背景（2026-11-08，跨项目防线 gap-guard G3 报出来的）：
 *   SELF_PORTS 在 agent-owner.js（SSOT）与 tools/agent-conflict-check/conflict-check.js
 *   （可分发镜像）各有一份。镜像本身是有意为之——让冲突检测零依赖、npx 即用——
 *   但它意味着「改一处忘一处」会静默漂移。
 *
 * 已经漂过一次：dsh 从 codex lane 独立成 18797 之后，两张表都没补。
 * 后果不是崩溃，是**纯误报**：用户把 base_url 指向 dsh-proxy(18797)，面板报
 * 「被别的工具占用」。误报比漏报更伤信任——它逼用户去查一个根本不存在的问题。
 *
 * 所以这里不靠人记得：预期集合直接从 manage.sh 的 *_PORT 解析，
 * 少一个就红；镜像与 SSOT 再逐值对拍。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MANAGE_SH = path.join(REPO_ROOT, 'manage.sh');
const MIRROR = path.join(REPO_ROOT, 'tools', 'agent-conflict-check', 'conflict-check.js');

const ssot = require('../../lib/agent-owner');

/** 从 manage.sh 抽出所有 *_PORT=NNNNN（= 本项目真正会 listen 的端口） */
function portsFromManageSh() {
  const src = fs.readFileSync(MANAGE_SH, 'utf8');
  const out = new Set();
  // 只看赋值行，避免把注释里提到的示例端口也算进来。
  // 变量名大小写混写（manage.sh 里真有 `CODEx_PORT=18790`），所以用 [A-Za-z_]。
  const re = /^\s*[A-Za-z_]+_PORT=(\d{2,5})\s*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

describe('SELF_PORTS 与真源对拍', () => {
  it('manage.sh 里能解析出端口（否则本测试自身失效）', () => {
    const ports = portsFromManageSh();
    expect(ports.size).toBeGreaterThanOrEqual(8);
    // 抽查几个锚点，防止正则被改坏后「空集 ⊆ 任意集合」恒真
    expect(ports.has('18790')).toBe(true);
    expect(ports.has('18880')).toBe(true);
  });

  it('SSOT（agent-owner.js）覆盖 manage.sh 里每一个会 listen 的端口', () => {
    const missing = [...portsFromManageSh()].filter((p) => !ssot.SELF_PORTS.includes(p));
    expect(missing).toEqual([]);
  });

  it('镜像（conflict-check.js）也覆盖 manage.sh 里每一个端口', () => {
    // 零依赖镜像：直接读源码抽数组，不用 require —— 它可能有自己的 CLI 副作用
    const src = fs.readFileSync(MIRROR, 'utf8');
    const m = src.match(/const SELF_PORTS = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const mirrorPorts = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const missing = [...portsFromManageSh()].filter((p) => !mirrorPorts.includes(p));
    expect(missing).toEqual([]);
  });

  it('镜像与 SSOT 逐值一致（顺序也一致，防止「只加一边」）', () => {
    const src = fs.readFileSync(MIRROR, 'utf8');
    const m = src.match(/const SELF_PORTS = \[([^\]]*)\]/);
    const mirrorPorts = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    expect(mirrorPorts).toEqual(ssot.SELF_PORTS);
  });

  it('自家端口一律不算占用（含 dsh 18797 —— 它就是漏掉过的那个）', () => {
    for (const p of ssot.SELF_PORTS) {
      expect(ssot.isOccupantPort(p)).toBe(false);
    }
    // 光断上面那行不够：18797 不在 OCCUPANT_PORTS 里，就算它从 SELF_PORTS 掉出去，
    // isOccupantPort('18797') 也照样返回 false —— 这条测试会因为错的理由变绿。
    // 真正该钉的是「占用者清单被污染成含自家端口时，仍然排除自家」：
    // 少了这一步，dsh 那个 bug 换个形态还能溜回来。
    for (const p of ssot.SELF_PORTS) {
      expect(ssot.isOccupantPort(p, ['15721', p])).toBe(false);
    }
    // 竞品端口仍然要认出来，别把「排除自家」做成「全都不算」
    expect(ssot.isOccupantPort('15721', ['15721', '18797'])).toBe(true);
  });
});
