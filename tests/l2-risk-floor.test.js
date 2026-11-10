// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

'use strict';

/**
 * 后果兜底（_applyRiskFloor）的验收测试。
 *
 * 为什么存在：`complexity` 只表示「执行规模」，后果可逆性本该走独立出口
 * （ADR-0005 的 workType / premiumExempt）。那个 ADR 至今 proposed 未落码，
 * 于是「付款指令核查」这类 refs=1/deps=0、规模确实 low、错了却直接亏钱的任务，
 * 会被老实派给小模型。这条兜底是那个缺口的最小补丁。
 *
 * ⚠️ 输入字段是 `consequence`，**不是 `redo_risk`**。
 *    2026-11-03 实测：`redo_risk` 与执行规模的相关系数 r=0.728，
 *    19 条 redo_risk=3 里 17 条本身就是 high 规模——拿它兜底等于空转。
 *    而且 LLM 自产风险值不可行（三档一致率 51%、二分类 recall 23.5%），
 *    所以 consequence 必须由确定性规则或人工给出。详见定案文档 §八。
 *
 * 四条成功标准：
 *   1. 没有 impact（或不是 'high'）时，行为与改动前逐字一致。
 *   2. impact='high' 且档位低于 medium 时抬到 medium，并在 decision 里留痕。
 *   3. impact='high' 但已经是 high 时不降档。
 *   4. 大小写 / 非法值不误伤；按旧接口传 redoRisk 不生效。
 *
 * 跑法：node tests/l2-risk-floor.test.js
 */

const assert = require('assert');
const path = require('path');
const { RouteEngine } = require(path.join(__dirname, '..', 'l2', 'route-engine.js'));

function makeEngine(opts = {}) {
    return new RouteEngine({ registry: { list: () => [] }, shadowMode: true, ...opts });
}

function routeWith(task) {
    return makeEngine().route({ type: 'code', prompt: 'p', ...task });
}

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('无 consequence：档位行为与改动前一致，且不留兜底痕迹', () => {
    for (const [complexity, tier] of [['low', 'small'], ['medium', 'medium'], ['high', 'large']]) {
        const d = routeWith({ complexity });
        assert.strictEqual(d.expectedTier, tier, `${complexity} 应映射 ${tier}`);
        assert.strictEqual(d.complexityConsequenceFloor, undefined, '不该出现兜底痕迹');
    }
});

t('consequence=high + low：抬到 medium 并留痕', () => {
    const d = routeWith({ complexity: 'low', consequence: 'high' });
    assert.strictEqual(d.expectedTier, 'medium');
    assert.deepStrictEqual(d.complexityConsequenceFloor, { from: 'low', to: 'medium', consequence: 'high' });
});

t('consequence=high + high：不降档，也不留痕', () => {
    const d = routeWith({ complexity: 'high', consequence: 'high' });
    assert.strictEqual(d.expectedTier, 'large');
    assert.strictEqual(d.complexityConsequenceFloor, undefined, '没改动就不该留痕');
});

t("consequence 只有 'high' 才触发：medium / low / undefined / 空都不动", () => {
    for (const consequence of ['medium', 'low', undefined, null, '']) {
        const d = routeWith({ complexity: 'low', consequence });
        assert.strictEqual(d.expectedTier, 'small', `impact=${String(consequence)} 不该抬档`);
        assert.strictEqual(d.complexityConsequenceFloor, undefined);
    }
});

t('consequence 大小写不敏感（HIGH / High / 带空格都认）', () => {
    for (const consequence of ['HIGH', 'High', ' high ']) {
        const d = routeWith({ complexity: 'low', consequence });
        assert.strictEqual(d.expectedTier, 'medium', `consequence=${consequence} 应识别为 high`);
    }
});

t('传旧字段 redoRisk / impact 不生效（防止有人按老接口接）', () => {
    const d = routeWith({ complexity: 'low', redoRisk: 3 });
    assert.strictEqual(d.expectedTier, 'small', 'redoRisk 不是 consequence，不该触发兜底');
    const d2 = routeWith({ complexity: 'low', impact: 'high' });
    assert.strictEqual(d2.expectedTier, 'small', 'impact 是 impact.js 的概念（变更半径），不是 consequence');
});

t('未知 complexity：不猜档，交给 _mapTier 原逻辑（归 medium）', () => {
    const d = routeWith({ complexity: 'weird', consequence: 'high' });
    assert.strictEqual(d.expectedTier, 'medium', '未知档位走 mapTier 的默认 medium');
});

t('_applyRiskFloor 是纯函数：不依赖也不修改实例状态', () => {
    const e = makeEngine();
    assert.strictEqual(e._applyRiskFloor('low', 'high'), 'medium');
    assert.strictEqual(e._applyRiskFloor('low', 'high'), 'medium');
    assert.strictEqual(e._applyRiskFloor('low', 'low'), 'low');
    assert.strictEqual(e._applyRiskFloor('medium', 'high'), 'medium');
    assert.strictEqual(e._applyRiskFloor('high', 'high'), 'high');
});

let pass = 0;
let fail = 0;
for (const [name, fn] of cases) {
    try {
        fn();
        pass += 1;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        fail += 1;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
    }
}
console.log(`\n${pass}/${pass + fail} PASS${fail ? `  ${fail} FAIL` : ''}`);
process.exit(fail ? 1 : 0);
