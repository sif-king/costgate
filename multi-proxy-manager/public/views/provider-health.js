// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · Provider 隔离卡（2.3b 第九片，2026-11-15）
   ----------------------------------------------------------------------------
   概览页（#page-dashboard）第三张卡，标题「Provider 健康」，数据只来自
   GET /api/provider-health。这个模块只有 20 行有效代码，为什么还单独一个文件：

     因为它**没有实现**。渲染逻辑与「读失败」写法都在 mp-shared.js（renderProviderIsolation
     / showProviderReadError）——那里是 2026-11-14 把概览卡与健康页两处逐字重复的 HTML
     合并后的唯一真源。留在页面 IIFE 里的那两个同名函数只是纯转发别名
     （`return MPShared.renderProviderIsolation(...)`），除了本卡的 load 没有任何调用者。
     把 load 搬走后，它们就是死码；而死码最坏的后果不是占地方，是**下一个人以为
     这里还能改文案**。所以这一片的判定是：本卡取数进模块、页面两个转发别名删掉，
     全仓只剩「模块 → MPShared」这一条路径。

   两条铁律不在这里，在 mp-shared.js（读失败必须走 showProviderReadError；
   副标题必须一起清空）。本模块只负责「别绕过它」。

   依赖（见 dashboard.html head 与 coherence 第 7 项）：
     · mp-kernel.js  → MPKernel.fetchJSON / getToken
     · mp-shared.js  → MPShared.renderProviderIsolation / showProviderReadError
   两者都缺一不可：缺 MPShared 时不许自己拼一份 HTML（那正是要消灭的第二真源）。

   公开面：window.MPViews.providerHealth.{ load }
           页面保留同名薄包装 loadProviderHealth（init 与自动刷新按名字调它）。
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  var SH = global.MPShared;
  if (!K || !SH) {
    console.error('[views/provider-health] 缺少 MPKernel / MPShared：请按 head 顺序加载 mp-kernel.js → mp-shared.js');
    return;
  }

  var fetchJSON = K.fetchJSON;

  var LIST_ID = 'phList';
  var SUB_ID = 'phSubtitle';

  function load() {
    fetchJSON('/api/provider-health', { headers: { 'x-auth-token': K.getToken() || '' } })
      .then(function (data) {
        SH.renderProviderIsolation(LIST_ID, SUB_ID, data);
      })
      .catch(function (err) {
        // 不走 renderProviderIsolation：读失败时「所有 Provider 健康」就是替一个
        // 没查过的系统开健康证明（mp-shared.js 里写着这条，这里只负责照做）。
        SH.showProviderReadError(LIST_ID, SUB_ID, err, load);
      });
  }

  global.MPViews = global.MPViews || {};
  global.MPViews.providerHealth = { load: load };
})(window);
