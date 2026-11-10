// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// one-off: eyeball the real rendered #gateBar on /dashboard after the 3+fold+amber merge
(async () => {
  const { chromium } = require('playwright');
  const b = await chromium.launch({ headless: true, channel: 'chrome' });
  const p = await b.newPage();
  p.on('console', m => console.log('[console]', m.type(), m.text()));
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.goto('http://127.0.0.1:18801/dashboard', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => (document.getElementById('gateBar') || {}).getAttribute && document.getElementById('gateBar').getAttribute('data-loaded') === '1',
    { timeout: 6000 }).catch(() => {});
  const info = await p.evaluate(() => {
    const bar = document.getElementById('gateBar');
    if (!bar) return { error: 'no #gateBar' };
    return {
      dataLoaded: bar.getAttribute('data-loaded'),
      pillStock: bar.querySelector('.gate-bar-pill-stock') ? bar.querySelector('.gate-bar-pill-stock').textContent.trim() : null,
      pill: bar.querySelector('.gate-bar-pill') ? bar.querySelector('.gate-bar-pill').textContent.trim() : null,
      leadCount: bar.querySelectorAll('.mp-lead .gate-chip').length,
      leadTexts: [...bar.querySelectorAll('.mp-lead .gate-chip')].map(c => c.textContent.trim()),
      leadClasses: [...bar.querySelectorAll('.mp-lead .gate-chip')].map(c => c.className),
      expandDisplay: getComputedStyle(bar.querySelector('.mp-gatebar-expand')).display,
      listChips: bar.querySelectorAll('.gate-bar-list .gate-chip').length,
      amberListChips: bar.querySelectorAll('.gate-bar-list .gate-chip-shadow').length,
      fullText: bar.innerText.replace(/\s+/g, ' ').slice(0, 360),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await b.close();
})();
