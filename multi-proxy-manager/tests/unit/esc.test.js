// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/**
 * esc() XSS 防护测试（§F 收尾：dashboard esc() 用例）。
 *
 * 覆盖两层：
 *   1. tests/unit/helpers/esc.js（纯 Node 实现）的行为正确性；
 *   2. 7 个前端 HTML 里的 esc() 源码契约——每个文件必须仍然包含完整的
 *      转义策略（DOM 式 textContent→innerHTML + " ' 两条补充替换，
 *      或等价的正则五替换），防止某次改动把某个页面的转义弄丢。
 *
 * 已知无害差异：助手把 ' 编码为 &#039;，浏览器 DOM 式编码为 &#39;，
 * 两者都是合法 HTML 实体且都不可逃逸，属外观差异不做强一致。
 */

const fs = require('fs');
const path = require('path');
const { esc } = require('./helpers/esc');

describe('esc() — 基础实体编码', () => {
  test('五个 HTML 元字符全部转义', () => {
    expect(esc('&')).toBe('&amp;');
    expect(esc('<')).toBe('&lt;');
    expect(esc('>')).toBe('&gt;');
    expect(esc('"')).toBe('&quot;');
    expect(esc("'")).toBe('&#039;');
  });

  test('混合字符串逐字符保留顺序', () => {
    expect(esc('a<b>&c"d\'e')).toBe('a&lt;b&gt;&amp;c&quot;d&#039;e');
  });

  test('& 必须最先替换（防二重编码回归）', () => {
    // 若替换顺序被改成先 < 后 &，"<" 会变成 "&amp;lt;"——可读但等于没转义
    expect(esc('<')).toBe('&lt;');
    expect(esc('<>&')).toBe('&lt;&gt;&amp;');
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  test('空串与无元字符串原样返回', () => {
    expect(esc('')).toBe('');
    expect(esc('hello world 123')).toBe('hello world 123');
  });

  test('中文与 emoji 原样通过（不被误伤）', () => {
    expect(esc('你好，世界')).toBe('你好，世界');
    expect(esc('部署✅完成')).toBe('部署✅完成');
  });

  test('长字符串不丢内容', () => {
    const long = '<script>'.repeat(1000);
    const out = esc(long);
    expect(out).not.toContain('<script>');
    expect(out.length).toBe('<script>'.length * 1000 + 1000 * ('&lt;'.length - 1) + 1000 * ('&gt;'.length - 1));
  });
});

describe('esc() — 类型守卫', () => {
  test('非字符串输入一律返回空串', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('');
    expect(esc({ a: 1 })).toBe('');
    expect(esc(['<b>'])).toBe('');
    expect(esc(true)).toBe('');
  });

  test('数字 0 / false 等 falsy 非字符串同样返回空串', () => {
    expect(esc(0)).toBe('');
    expect(esc(false)).toBe('');
    expect(esc(NaN)).toBe('');
  });
});

describe('esc() — XSS 载荷语料', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    "'-alert(1)-'",
    '<iframe src="javascript:alert(1)">',
    '</script><script>alert(1)</script>',
    '<a href="javascript:alert(1)">x</a>',
    '<input onfocus=alert(1) autofocus>',
    '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
    '<form><button formaction=javascript:alert(1)>x',
  ];

  // 安全不变量（正确口径）：转义后不存在裸尖括号与裸引号。
  // javascript: / onmouseover= 等字样可作为纯文本残留——标签已被实体化，它们无害。
  const assertInert = (out) => {
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toContain('"');
    expect(out).not.toContain("'");
  };

  test.each(payloads)('载荷被中性化：%s', (p) => {
    assertInert(esc(p));
  });

  test('含 < 的载荷必然发生尖括号转义', () => {
    for (const p of payloads.filter(x => x.includes('<'))) {
      expect(esc(p)).toContain('&lt;');
    }
  });

  test('引号载荷发生引号转义', () => {
    expect(esc('"-alert(1)-"')).toContain('&quot;');
    expect(esc("'-alert(1)-'")).toContain('&#039;');
  });

  test('on* 事件处理器失去标签挂点', () => {
    const out = esc('<div onmouseover="alert(1)">hover</div>');
    assertInert(out);
    expect(out).toContain('&lt;div onmouseover=&quot;alert(1)&quot;&gt;');
  });

  test('二次转义是显式行为（esc(esc(x))），不产生裸标签', () => {
    const once = esc('<b>');
    const twice = esc(once);
    expect(twice).toBe('&amp;lt;b&amp;gt;');
    assertInert(twice);
  });
});

describe('esc() — 前端页面源码契约', () => {
  // 2026-11-14：转义助手从「每页抄一份」收到 public/mp-kernel.js（8 页共用）。
  // 契约随之改口径：页面**要么**自带完整实现，**要么**引用 MPKernel.esc；
  // 引用者不得再留第二份本地实现（留一份就留了一条分叉路）。
  // 光看源码文本已经不成立——真正的保证改成下面那组「真跑 kernel」的行为用例。
  const htmlFiles = [
    'dashboard.html', 'floor.html', 'sessions.html', 'logs.html',
    'knowledge.html', 'proxy-config.html', 'skills.html',
  ];

  test.each(htmlFiles)('%s 有可用的 esc（自带实现或引用 MPKernel）', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', file), 'utf8');
    const m = src.match(/function\s+esc\s*\([^)]*\)\s*\{/);
    if (m) {
      // 自带实现：必须仍然完整（两条已知策略之一）
      const body = src.slice(m.index, m.index + 600);
      const isDomStrategy = body.includes('textContent') && body.includes('innerHTML');
      const isRegexStrategy = /&amp;/.test(body) && /&lt;/.test(body) && /&gt;/.test(body);
      expect(isDomStrategy || isRegexStrategy).toBe(true);
      if (isDomStrategy) {
        expect(body).toMatch(/replace\(\/["']\/g/);
      } else {
        expect(body).toMatch(/\[&<>"']/);
      }
      return;
    }
    // 走到这里就必须是「引用 kernel」，而且必须是 var/let/const esc = MPKernel.esc 这种真赋值
    expect(src).toMatch(/(var|let|const)\s+esc\s*=\s*(window\.)?MPKernel\.esc\s*;/);
  });

  test.each(htmlFiles)('%s 的 <script> 引了 mp-kernel.js（引用者必备）', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', file), 'utf8');
    const ownImpl = /function\s+esc\s*\([^)]*\)\s*\{/.test(src);
    if (ownImpl) return; // 自己带实现的不要求引 kernel
    expect(src).toMatch(/<script\s+src="\.\/mp-kernel\.js"><\/script>/);
  });

  // 审计备注（2026-10-14）：public/ 下其余页面已逐个人工审计——
  //   index.html 无 innerHTML；login.html 两处 innerHTML 一处为静态 SVG 切换、
  //   一处只插服务端下发的数字分钟数，均不注入用户可控字符串，故不强制要求 esc。
  //   新增页面若出现 innerHTML 注入动态内容，必须同步补 esc 并加入上方清单。
});

describe('esc() — mp-kernel.js 真跑（行为契约，不看源码文本）', () => {
  // 为什么真跑：上一条只能证明「函数还在」，证明不了「转义还管用」。
  // 曾出现过「实现被改成只替换 < >，引号漏了」而文本断言仍绿的情形。
  const vm = require('vm');
  const KERNEL = path.join(__dirname, '..', '..', 'public', 'mp-kernel.js');

  function loadKernel() {
    const sandbox = { console };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(KERNEL, 'utf8'), sandbox, { filename: 'mp-kernel.js' });
    return sandbox.MPKernel;
  }

  const K = loadKernel();

  test('公开面齐全（esc / fetchJSON / showReadError / getToken）', () => {
    expect(typeof K.esc).toBe('function');
    expect(typeof K.fetchJSON).toBe('function');
    expect(typeof K.showReadError).toBe('function');
    expect(typeof K.getToken).toBe('function');
  });

  test('五个元字符全部转义且 & 优先（与 helpers/esc.js 同口径）', () => {
    const normalize = (s) => s.replace(/&#0?39;/g, '&#39;'); // 两个合法实体归一
    const corpus = ['&', '<', '>', '"', "'", 'a<b>&c"d\'e', '&lt;', '你好✅', ''];
    for (const s of corpus) {
      expect(normalize(K.esc(s))).toBe(normalize(esc(s)));
    }
  });

  test('逐项映射精确正确（缺一项不许退化成 undefined）', () => {
    // 为什么要有这条：只断言「输出里没有裸引号」漏得掉一种坏法——映射表少了一项时
    // String.replace 的回调返回 undefined，于是那个字符被替换成字符串 "undefined"。
    // 它既没有尖括号也没有引号，中性化断言照样绿，可页面上会凭空多出 "undefined"。
    expect(K.esc('<')).toBe('&lt;');
    expect(K.esc('>')).toBe('&gt;');
    expect(K.esc('&')).toBe('&amp;');
    expect(K.esc('"')).toBe('&quot;');
    expect(K.esc("'")).toBe('&#39;');
    expect(K.esc('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&#39;');
    expect(K.esc('a"b')).not.toContain('undefined');
  });

  test('XSS 载荷全部中性化（无裸尖括号 / 裸引号）', () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '"><svg onload=alert(1)>',
      "'-alert(1)-'",
      '</script><script>alert(1)</script>',
      '<form><button formaction=javascript:alert(1)>x',
    ];
    for (const p of payloads) {
      const out = K.esc(p);
      expect(out).not.toMatch(/[<>]/);
      expect(out).not.toContain('"');
      expect(out).not.toContain("'");
    }
  });

  test('null / undefined 返回空串，数字按文本处理（不再一律丢弃）', () => {
    // 口径变化（2026-11-14）：旧 helpers/esc.js 对非字符串一律返回空串，
    // 面板里 esc(0) / esc(12345) 其实需要显示数字——静默吞掉比显示错更难查。
    expect(K.esc(null)).toBe('');
    expect(K.esc(undefined)).toBe('');
    expect(K.esc(0)).toBe('0');
    expect(K.esc(12345)).toBe('12345');
  });

  test('getToken 每次现读 sessionStorage（不缓存）', () => {
    const store = new Map([['auth_token', 't1']]);
    const sandbox = {
      console,
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
      },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(KERNEL, 'utf8'), sandbox, { filename: 'mp-kernel.js' });
    expect(sandbox.MPKernel.getToken()).toBe('t1');
    store.set('auth_token', 't2'); // 模拟页内登录后换令牌
    expect(sandbox.MPKernel.getToken()).toBe('t2');
    store.delete('auth_token');
    expect(sandbox.MPKernel.getToken()).toBe(null);
  });
});
