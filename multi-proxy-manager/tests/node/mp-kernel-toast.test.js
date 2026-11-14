// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

// mp-kernel 的 showToast 行为测试（2026-11-14 视觉统一）
//
// 为什么要有它：toast 过去在 7 个页面各有一份实现、三套观感，其中 settings 的
// `.toast--info` 类名在 CSS 里**从未定义**——加了类却没样式，谁都没发现，因为
// 没有人测过「提示长什么样」。合并成一份之后，至少要钉住三件事：
//   ① 结构与类名契约（.toast <type> + .toast-icon + .toast-msg），CSS 靠它生效；
//   ② type 白名单（脏值不许变成没有样式的类名）；
//   ③ 消息是文本节点，不是 HTML（后端错误串里带 < > 也不能变成元素）。
//
// 这里在 vm 里跑**真文件** mp-kernel.js，不塞桩实现——桩测的是桩。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');
const assert = require('node:assert');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

// ── 最小 DOM ────────────────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tag: tag || 'div',
    id: '',
    _text: '',
    _html: '',
    className: '',
    children: [],
    attrs: {},
    style: {},
    parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = String(v); this._html = ''; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); },
  });
  return el;
}

function makeSandbox() {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) {
      const e = makeEl('div');
      e.id = id;
      registry.set(id, e);
    }
    return registry.get(id);
  };
  const timers = [];
  const sandbox = {
    document: {
      getElementById: getEl,
      createElement: (tag) => makeEl(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    // 定时器收集起来手动跑：不收集就只能等真实 3 秒，或者被 setTimeout 的
    // 立即执行版本掩盖「先入队后移除」的时序错误。
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(PUBLIC, 'mp-kernel.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'mp-kernel.js' });
  return { sandbox, getEl, timers };
}

function lastToast(getEl) {
  const host = getEl('toastContainer');
  return host.children[host.children.length - 1];
}

test('showToast：结构与类名契约（CSS 靠它生效）', () => {
  const { sandbox, getEl } = makeSandbox();
  sandbox.MPKernel.showToast('保存成功', 'success', 1000);

  const el = lastToast(getEl);
  assert.ok(el, '应该在 toastContainer 里追加一个元素');
  assert.strictEqual(el.className, 'toast success', '类名必须是 .toast <type>，components.css 才认');
  assert.strictEqual(el.children.length, 2, '应有图标 + 文本两个子节点');
  assert.strictEqual(el.children[0].className, 'toast-icon');
  assert.ok(el.children[0].innerHTML.includes('<svg'), '图标位应放内联 SVG');
  assert.strictEqual(el.children[1].className, 'toast-msg');
  assert.strictEqual(el.children[1].textContent, '保存成功');
  assert.strictEqual(el.getAttribute('role'), 'status', '提示要让读屏用户也能听到');
});

test('showToast：type 白名单，脏值不产生没有样式的类名', () => {
  const { sandbox, getEl } = makeSandbox();
  for (const dirty of ['ERROR', 'bogus', '', null, undefined, 'info ', 'success"']) {
    const before = getEl('toastContainer').children.length;
    sandbox.MPKernel.showToast('x', dirty);
    const el = getEl('toastContainer').children[before];
    assert.strictEqual(el.className, 'toast info', `type=${JSON.stringify(dirty)} 应落到 info，而不是拼进类名`);
  }
  // 合法值原样保留
  for (const ok of ['success', 'error', 'warning']) {
    const before = getEl('toastContainer').children.length;
    sandbox.MPKernel.showToast('x', ok);
    assert.strictEqual(getEl('toastContainer').children[before].className, 'toast ' + ok);
  }
});

test('showToast：消息按文本插入，HTML 载荷不会变成元素', () => {
  const { sandbox, getEl } = makeSandbox();
  const payload = '<img src=x onerror="alert(1)">';
  sandbox.MPKernel.showToast(payload, 'error');
  const msg = lastToast(getEl).children[1];
  assert.strictEqual(msg.textContent, payload, '原样保留（用户看得到它是什么）');
  assert.strictEqual(msg.children.length, 0, '不许创建子元素——textContent 不是 innerHTML');
  assert.strictEqual(msg.innerHTML, '', 'HTML 位应为空，证明没有解析载荷');
});

test('showToast：容器缺失时安静返回，不抛错', () => {
  const { sandbox } = makeSandbox();
  // 把 getElementById 换成恒 null：模拟提示容器被删/页面结构改坏
  sandbox.document.getElementById = () => null;
  assert.doesNotThrow(() => sandbox.MPKernel.showToast('x', 'info'));
});

test('showToast：默认 3s 后淡出并从 DOM 移除', () => {
  const { sandbox, getEl, timers } = makeSandbox();
  const host = getEl('toastContainer');
  sandbox.MPKernel.showToast('x', 'info');
  assert.strictEqual(host.children.length, 1);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 3000, '不传 duration 时默认 3000ms');

  timers[0].fn();                     // 到点：开始淡出
  assert.ok(lastToast(getEl).style.animation.includes('toast-out'), '应挂 toast-out 动画');
  assert.strictEqual(host.children.length, 1, '淡出动画期间元素还在');

  timers[1].fn();                     // 300ms 后：真正移除
  assert.strictEqual(host.children.length, 0, '动画结束必须从 DOM 摘掉，否则一直堆在右上角');
});

test('showToast：显式 duration 生效（proxy-config 原来 2500 / settings 3600）', () => {
  const { sandbox, timers } = makeSandbox();
  sandbox.MPKernel.showToast('x', 'info', 1200);
  assert.strictEqual(timers[0].ms, 1200);
});
