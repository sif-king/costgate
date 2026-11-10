#!/usr/bin/env node
// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// verify-delivery.js — L4 live 发布校验器（2026-10-30）
//
// 把 docs/RELEASE-CHECKLIST.md 的「静态快照」改成「live 校验」：读真源码 + 跑（安全的）命令，
// 产出「宣称 / 证据 / 状态」实时表。直接消除设计稿 §2 铁证 A/B（文档比代码落后 N 天）。
//
// 用法：
//   node scripts/verify-delivery.js                     # 扫当前仓根（= 脚本所在仓）
//   node scripts/verify-delivery.js --root <dir>        # 扫指定项目
//   node scripts/verify-delivery.js --json              # 机器可读
//   node scripts/verify-delivery.js --warn              # 基线期：有 fail/blk 也只 warn、exit 0
//   node scripts/verify-delivery.js --only web-pages,update-honest
//   node scripts/verify-delivery.js --selftest          # 元守卫：每 check 正反 fixture 对称量，防恒绿腐化
//
// 退出码（默认）：有 status=fail → 1；仅 blk/warn（信息性）→ 0；全 pass/na → 0。
// 设计取向：每条 check 都是「确定性、只读、不 flaky」的检验；不依赖跑全量测试（那归 p0 门）。
// 零依赖（仅 node 内建 fs/path/child_process），与 gap-guard run.js 同范式。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------- 小工具 ----------
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function nonEmptyHtml(dir) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html') && f !== 'index.html'
    || (f.endsWith('.html') && f === 'index.html'))
    .filter((f) => { try { return fs.statSync(path.join(dir, f)).size > 0; } catch { return false; } });
}
function grepFile(p, re) { const t = readFileSafe(p); return t ? re.test(t) : false; }

// ---------- check（每个返回 {id, claim, status, evidence}；status: pass|fail|blk|na|warn） ----------
const CHECKS = [
  function webPages(root) {
    const dir = path.join(root, 'multi-proxy-manager', 'public');
    const pages = nonEmptyHtml(dir);
    const ok = pages.length > 0;
    return {
      id: 'web-pages',
      claim: '开箱即用·web：public/ 有可 serve 的页面',
      status: ok ? 'pass' : 'fail',
      evidence: ok ? `${pages.length} 页：${pages.slice(0, 5).join(', ')}${pages.length > 5 ? '…' : ''}`
        : `${dir} 无 .html（目录存在=${exists(dir)}）`,
    };
  },
  function webServe(root) {
    const srv = path.join(root, 'multi-proxy-manager', 'server.js');
    const ok = grepFile(srv, /express\.static|res\.sendFile|sendFile\(/);
    return {
      id: 'web-serve',
      claim: 'server.js 挂载 static / sendFile（页面能真被 serve）',
      status: ok ? 'pass' : 'fail',
      evidence: ok ? `server.js 命中 static/sendFile` : `server.js 无 static 挂载（文件存在=${exists(srv)}）`,
    };
  },
  function consentWired(root) {
    const lib = path.join(root, 'multi-proxy-manager', 'lib', 'consent.js');
    const srv = path.join(root, 'multi-proxy-manager', 'server.js');
    const libOk = exists(lib);
    const wired = grepFile(srv, /consent/);
    const ok = libOk && wired;
    return {
      id: 'consent-wired',
      claim: '首启同意：server 侧已 wire lib/consent.js + /api/consent*',
      status: ok ? 'pass' : 'fail',
      evidence: `lib/consent.js 存在=${libOk}；server.js 引用 consent=${wired}`,
    };
  },
  function hotpathPresent(root) {
    const f = path.join(root, 'multi-proxy-manager', 'lib', 'forward.js');
    const p = path.join(root, 'codex-proxy', 'proxy.js');
    const ok = exists(f) && exists(p);
    return {
      id: 'hotpath-present',
      claim: '热路径 multi-proxy-manager/lib/forward.js / codex-proxy/proxy.js 存在（不崩前置；回归靠 p0 测试门）',
      status: ok ? 'pass' : 'fail',
      evidence: `lib/forward.js=${exists(f)}；codex-proxy/proxy.js=${exists(p)}`,
    };
  },
  function updateHonest(root) {
    const script = path.join(root, 'tools', 'update-check.js');
    if (!exists(script)) {
      return { id: 'update-honest', claim: '软件内更新：默认关 + 诚实话术（非假宣称）', status: 'fail',
        evidence: 'tools/update-check.js 不存在' };
    }
    const r = spawnSync(process.execPath, [script, '--json'], { timeout: 8000, encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) {
      return { id: 'update-honest', claim: '软件内更新：默认关 + 诚实话术（非假宣称）', status: 'warn',
        evidence: `update-check.js 无法判定（rc=${r.status} / 超时 / 空输出）` };
    }
    let j; try { j = JSON.parse(r.stdout); } catch { j = null; }
    if (!j) return { id: 'update-honest', claim: '软件内更新：默认关 + 诚实话术（非假宣称）', status: 'warn',
      evidence: `非 JSON 输出：${r.stdout.trim().slice(0, 80)}` };
    const honestDefaultOff = j.checked === false && /default-off|关/.test(String(j.reason || ''));
    return {
      id: 'update-honest',
      claim: '软件内更新：默认关 + 诚实话术（非假宣称）',
      status: honestDefaultOff ? 'pass' : 'fail',
      evidence: `node update-check.js --json => ${r.stdout.trim().slice(0, 100)}`,
    };
  },
  function desktopTwoFlavors(root) {
    // 信息性 check：§6.1 桌面二选一。两套并存且未拍板 = BLK（不红，L252 只 fail 触发）；
    // 已拍板（desktop/RETIRED.md 标记 Electron 退场、原生 Swift 为正路）= PASS。
    const electron = path.join(root, 'desktop');
    const swift = path.join(root, 'client');
    const retiredMarker = path.join(electron, 'RETIRED.md'); // §6.1 拍板标记（老板 2026-10-31）
    const both = exists(electron) && exists(swift);
    const app = nonEmptyHtml(swift ? path.join(swift, 'build') : '') // 仅探测 build 目录是否非空
      .length > 0 || (exists(path.join(swift, 'build', 'MultiProxy.app')) ? true : false);
    if (!both) {
      return {
        id: 'desktop-two-flavors',
        claim: '桌面交付：走哪条（Electron desktop/ vs 原生 Swift client/）',
        status: 'na',
        evidence: `未并存（desktop=${exists(electron)}, client=${exists(swift)}）`,
      };
    }
    if (exists(retiredMarker)) {
      return {
        id: 'desktop-two-flavors',
        claim: '桌面交付：走哪条（Electron desktop/ vs 原生 Swift client/）',
        status: 'pass',
        evidence: `已拍板 §6.1（老板 2026-10-31）：原生 Swift(client/) 为桌面交付唯一正路，Electron(desktop/) 退场（代码保留参考，见 desktop/RETIRED.md）。guard「不破坏一切皆插件」成立——两壳均只把 manager web 控制台(18792/dashboard.html) 塞进 WebView（Electron BrowserWindow vs Swift WKWebView），插件内核(UI 面板/路由/适配器热插拔)在 L2，与壳正交。build/MultiProxy.app=${app}`,
      };
    }
    return {
      id: 'desktop-two-flavors',
      claim: '桌面交付：走哪条（Electron desktop/ vs 原生 Swift client/）',
      status: 'blk',
      evidence: `两套并存：desktop/(Electron)=存在、client/(Swift)=存在，client/build/MultiProxy.app=${app} → 待拍板 §6.1`,
    };
  },
  function driftIntegration(root, runDrift) {
    const d = runDrift(root); // 调 drift-check.js --json
    if (d.error) {
      return { id: 'drift-integration', claim: 'L5 文档↔代码漂移（仓内 A 类）', status: 'warn',
        evidence: `drift-check 不可用：${d.error}` };
    }
    const n = d.drift;
    return {
      id: 'drift-integration',
      claim: 'L5 文档↔代码漂移（仓内 A 类）为 0 或已知基线内',
      status: n === 0 ? 'pass' : 'warn',
      evidence: `docs 中 ${n} 条仓内真漂移（基线期 38，随文档修好递减；详见 drift-check.js）`,
    };
  },
];

function runDrift(root) {
  const script = path.join(root, 'scripts', 'drift-check.js');
  if (!exists(script)) return { error: 'scripts/drift-check.js 缺失' };
  const r = spawnSync(process.execPath, [script, '--json'], { timeout: 20000, encoding: 'utf8' });
  // drift-check.js 退出码：0=无漂移 / 1=有漂移（两者都先打印合法 JSON 再退出）/ 2=自检失败。
  // 故 0/1 都解析 stdout 的 JSON 采信（drift 字段即真实条数）；仅 2（自检挂）或输出非 JSON 判不可用。
  let j = null; try { j = JSON.parse(r.stdout); } catch { j = null; }
  if (j && typeof j.drift === 'number') return { drift: j.drift, docs: j.docs, rc: r.status };
  if (r.status === 2) return { error: `drift-check 自检失败(rc=2)：${String(r.stderr || '').slice(0, 100)}` };
  return { error: `drift-check 输出不可解析(rc=${r.status})：${String(r.stdout || r.stderr || '').slice(0, 100)}` };
}

// ---------- selftest（元守卫：正反 fixture，防恒绿） ----------
function selftest() {
  const os = require('os');
  const path2 = path;
  let failed = 0;
  const mk = (name, fn) => {
    const dir = path2.join(os.tmpdir(), `vd-st-${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fn(dir);
    return dir;
  };
  // good：全通过（single-flavor 桌面，na）
  const good = mk('good', (d) => {
    const pub = path.join(d, 'multi-proxy-manager', 'public'); fs.mkdirSync(pub, { recursive: true });
    fs.writeFileSync(path.join(pub, 'dashboard.html'), '<html>x</html>');
    fs.writeFileSync(path.join(d, 'multi-proxy-manager', 'server.js'),
      "const express=require('express');const app=express();app.use(express.static('public'));const c=require('./lib/consent');");
    fs.mkdirSync(path.join(d, 'multi-proxy-manager', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(d, 'multi-proxy-manager', 'lib', 'consent.js'), "module.exports={};");
    fs.mkdirSync(path.join(d, 'multi-proxy-manager', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(d, 'multi-proxy-manager', 'lib', 'forward.js'), 'module.exports={};');
    fs.mkdirSync(path.join(d, 'codex-proxy'), { recursive: true });
    fs.writeFileSync(path.join(d, 'codex-proxy', 'proxy.js'), 'module.exports={};');
    fs.mkdirSync(path.join(d, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(d, 'tools', 'update-check.js'),
      "console.log(JSON.stringify({checked:false,reason:'default-off'}));");
    fs.mkdirSync(path.join(d, 'client', 'build'), { recursive: true }); // 单套 → na
  });
  // bad：逐项红
  const bad = mk('bad', (d) => {
    fs.mkdirSync(path.join(d, 'multi-proxy-manager', 'public'), { recursive: true }); // 空 public
    fs.writeFileSync(path.join(d, 'multi-proxy-manager', 'server.js'), 'module.exports={};'); // 无 static、无 consent
    fs.mkdirSync(path.join(d, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(d, 'tools', 'update-check.js'),
      "console.log(JSON.stringify({checked:true,version:'9.9.9'}));"); // checked:true → 假宣称
    fs.mkdirSync(path.join(d, 'desktop'), { recursive: true });
    fs.mkdirSync(path.join(d, 'client'), { recursive: true }); // 两套并存 → blk
  });
  const expect = {
    good: { 'web-pages': 'pass', 'web-serve': 'pass', 'consent-wired': 'pass',
      'hotpath-present': 'pass', 'update-honest': 'pass', 'desktop-two-flavors': 'na' },
    bad: { 'web-pages': 'fail', 'web-serve': 'fail', 'consent-wired': 'fail',
      'hotpath-present': 'fail', 'update-honest': 'fail', 'desktop-two-flavors': 'blk' },
  };
  for (const [name, want] of Object.entries(expect)) {
    const root = name === 'good' ? good : bad;
    const got = {};
    for (const c of CHECKS) {
      const r = c(root, runDrift);
      got[r.id] = r.status;
    }
    for (const [id, st] of Object.entries(want)) {
      if (got[id] !== st) {
        console.log(`✗ [${name}] ${id} 期望 ${st}，实得 ${got[id]}`); failed++;
      }
    }
  }
  fs.rmSync(good, { recursive: true, force: true }); fs.rmSync(bad, { recursive: true, force: true });
  if (failed === 0) console.log('✔ verify-delivery --selftest 通过（全 check 正反 fixture 对称）');
  else { console.log(`✗ selftest ${failed} 项不符`); process.exit(1); }
}

// ---------- 主流程 ----------
function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (flag('--selftest')) return selftest();
  const root = opt('--root') || ROOT;
  const only = opt('--only') ? opt('--only').split(',').map((s) => s.trim()) : null;
  const warn = flag('--warn');
  const json = flag('--json');

  const rows = CHECKS.map((c) => c(root, runDrift)).filter((r) => !only || only.includes(r.id));
  const fail = rows.filter((r) => r.status === 'fail');
  const blk = rows.filter((r) => r.status === 'blk');
  const w = rows.filter((r) => r.status === 'warn');

  if (json) {
    console.log(JSON.stringify({ root, generated: new Date().toISOString(), rows,
      summary: { fail: fail.length, blk: blk.length, warn: w.length } }, null, 2));
  } else {
    console.log(`verify-delivery · ${path.relative(ROOT, root) || '.'} · ${new Date().toISOString().slice(0, 19)}`);
    console.log('状态码：✓pass ✗fail ◆blk(待拍板) ~warn(信息) · na');
    const tag = { pass: '✓', fail: '✗', blk: '◆', warn: '~', na: '·' };
    for (const r of rows) {
      console.log(`${tag[r.status]} [${r.status.toUpperCase().padEnd(3)}] ${r.id.padEnd(20)} ${r.claim}`);
      console.log(`        证据：${r.evidence}`);
    }
    console.log(`\n小结：fail ${fail.length} · blk ${blk.length} · warn ${w.length}`);
    if (fail.length) console.log(`需处理：${fail.map((r) => r.id).join(', ')}`);
    if (blk.length) console.log(`待拍板：${blk.map((r) => r.id).join(', ')}`);
    if (warn) console.log(`信息项：${w.map((r) => r.id).join(', ')}`);
  }

  // 退出码
  if (warn) { if (fail.length || blk.length || w.length) console.log('\n[--warn] 基线期不阻断，exit 0'); process.exit(0); }
  process.exit(fail.length ? 1 : 0);
}

main();
