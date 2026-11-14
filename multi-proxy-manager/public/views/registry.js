// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

/* ============================================================================
   dashboard 子视图 · Agent 清单（registry）
   ----------------------------------------------------------------------------
   阶段 2.3b 第四片（2026-11-15）。为什么这一片可以抽：它只围绕
   /api/registry/agents 一个接口簇 + 两个私有状态（registryAgents /
   editingAgentId），不读 proxyStatus、不碰轮询、不被别的视图调用。与 alerts.js
   同形——抽离不需要先把 IIFE 变量全局化，这正是「共享状态层」要等 health/cost
   才做的原因。

   依赖（必须先加载，见 dashboard.html head）：
     · mp-kernel.js → MPKernel.esc / fetchJSON / showReadError / showToast / getToken
     · mp-shell.js  → MPShell 的加载条 / 离线横幅

   公开面：window.MPViews.registry.{ load, filter, agents }
           另挂 window.loadRegistryPage / filterRegistry / showAddAgentModal /
           closeAgentModal / saveAgent / editAgent / deleteAgent
           —— 前两个是静态 HTML 内联 handler，后五个是列表卡片里动态生成的
           onclick；两者都在**全局作用域**解析函数名（见 D-017 / D-018）。
   ========================================================================== */
(function (global) {
  'use strict';

  var K = global.MPKernel;
  if (!K) {
    console.error('[views/registry] 缺少 MPKernel：请先加载 mp-kernel.js');
    return;
  }
  var S = global.MPShell;
  if (!S) {
    console.error('[views/registry] 缺少 MPShell：请确认 mp-shell.js 在 views/*.js 之前加载');
    return;
  }
  var esc = K.esc;

  // 本视图私有状态：不挂 window、不与页面壳共享。
  var registryAgents = [];
  var editingAgentId = null;

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ===== 主加载：读失败绝不兜底成空清单 =====
  function load() {
    S.showLoading();
    K.fetchJSON('/api/registry/agents')
      .then(function (data) {
        registryAgents = data.agents || [];
        renderGrid(registryAgents);
        updateStats(registryAgents);
        S.hideOfflineBanner();
        S.hideLoading();
      })
      .catch(function (err) {
        // 过去这里 catch 成空列表 → 显示「暂无 Agent · 点击新增创建」。
        // 那是把「读不到」说成「一个都没有」，会让刚注册的 agent 像凭空消失。
        registryAgents = [];
        renderGrid([]);
        updateStats([]);
        K.showReadError('registryGrid', '读取失败', (err && err.message) || '未知错误',
          'Agent 清单读不到，不代表清单是空的。', load);
        S.hideLoading();
      });
  }

  function renderGrid(agents) {
    var grid = document.getElementById('registryGrid');
    if (!grid) return;

    if (agents.length === 0) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon"><svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><div class="empty-text">暂无 Agent · 点击「新增 Agent」创建</div></div>';
      return;
    }

    grid.innerHTML = agents.map(function (a) {
      var tags = (a.capabilityTags || []).map(function (t) { return '<span class="registry-tag">' + esc(t) + '</span>'; }).join('');
      var created = a.createdAt ? new Date(a.createdAt).toLocaleDateString('zh-CN') : '-';
      var updated = a.updatedAt ? new Date(a.updatedAt).toLocaleDateString('zh-CN') : '-';

      return '<div class="registry-card" id="registry-card-' + esc(a.id) + '">' +
        '<div class="registry-card-header">' +
          '<div class="registry-card-title">' + esc(a.name) + '</div>' +
          '<span class="registry-card-type">' + esc(a.type) + '</span>' +
        '</div>' +
        '<div class="registry-card-body">' +
          '<div style="font-size:12px;color:var(--color-text-tertiary);margin-bottom:8px;"><strong>ID:</strong> ' + esc(a.id) + '</div>' +
          (a.description ? '<div style="font-size:12px;color:var(--color-text-secondary);margin-bottom:8px;">' + esc(a.description) + '</div>' : '') +
          '<div style="font-size:11px;color:var(--color-text-tertiary);">创建: ' + esc(created) + ' · 更新: ' + esc(updated) + '</div>' +
        '</div>' +
        '<div class="registry-card-tags">' + tags + '</div>' +
        '<div class="registry-card-actions">' +
          '<button class="btn btn-outline btn-sm" onclick="editAgent(\'' + esc(a.id) + '\')">编辑</button>' +
          '<button class="btn btn-danger btn-sm" onclick="deleteAgent(\'' + esc(a.id) + '\')">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function updateStats(agents) {
    setText('registryTotalCount', agents.length);
    setText('registryCodexCount', agents.filter(function (a) { return a.type === 'codex'; }).length);
    setText('registryHermesCount', agents.filter(function (a) { return a.type === 'hermes'; }).length);
    setText('registryCursorCount', agents.filter(function (a) { return a.type === 'cursor'; }).length);
  }

  // ===== 搜索 / 类型筛选（HTML oninput/onchange 内联调用）=====
  function filter() {
    var search = (document.getElementById('registrySearch') || {}).value || '';
    var typeFilter = (document.getElementById('registryTypeFilter') || {}).value || '';

    var filtered = registryAgents.filter(function (a) {
      if (typeFilter && a.type !== typeFilter) return false;
      if (search) {
        var hay = (a.name + ' ' + a.id + ' ' + (a.capabilityTags || []).join(' ')).toLowerCase();
        if (hay.indexOf(search.toLowerCase()) === -1) return false;
      }
      return true;
    });

    renderGrid(filtered);
  }

  // ===== 新增 / 编辑弹窗 =====
  function showAddModal() {
    editingAgentId = null;
    setText('agentModalTitle', '新增 Agent');
    setText('agentModalSave', '创建');
    document.getElementById('agentId').value = '';
    document.getElementById('agentId').disabled = false;
    document.getElementById('agentName').value = '';
    document.getElementById('agentType').value = 'custom';
    document.getElementById('agentTags').value = '';
    document.getElementById('agentModelType').value = 'text';
    document.getElementById('agentDesc').value = '';
    document.getElementById('agentModal').style.display = 'flex';
  }

  function edit(id) {
    var agent = registryAgents.find(function (a) { return a.id === id; });
    if (!agent) return;

    editingAgentId = id;
    setText('agentModalTitle', '编辑 Agent');
    setText('agentModalSave', '保存');
    document.getElementById('agentId').value = agent.id;
    document.getElementById('agentId').disabled = true;
    document.getElementById('agentName').value = agent.name || '';
    document.getElementById('agentType').value = agent.type || 'custom';
    document.getElementById('agentTags').value = (agent.capabilityTags || []).join(', ');
    document.getElementById('agentModelType').value = agent.modelType || 'text';
    document.getElementById('agentDesc').value = agent.description || '';
    document.getElementById('agentModal').style.display = 'flex';
  }

  function closeModal() {
    document.getElementById('agentModal').style.display = 'none';
  }

  function save() {
    var id = document.getElementById('agentId').value.trim();
    var name = document.getElementById('agentName').value.trim();
    var type = document.getElementById('agentType').value;
    var tagsStr = document.getElementById('agentTags').value.trim();
    var modelType = document.getElementById('agentModelType').value;
    var description = document.getElementById('agentDesc').value.trim();

    if (!id || !name) {
      K.showToast('ID 和名称为必填项', 'error');
      return;
    }

    var tags = tagsStr ? tagsStr.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : [];
    var payload = {
      id: id,
      name: name,
      type: type,
      capabilityTags: tags,
      modelType: modelType,
      description: description,
    };

    var url = '/api/registry/agents' + (editingAgentId ? '/' + encodeURIComponent(editingAgentId) : '');
    var method = editingAgentId ? 'PUT' : 'POST';

    fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'x-auth-token': K.getToken() || '' },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.id || data.success) {
          K.showToast(editingAgentId ? 'Agent 已更新' : 'Agent 已创建', 'success');
          closeModal();
          load();
        } else {
          K.showToast(data.error || '操作失败', 'error');
        }
      })
      .catch(function (err) {
        K.showToast('操作失败: ' + err.message, 'error');
      });
  }

  function remove(id) {
    if (!global.confirm('确认删除 Agent "' + id + '"？')) return;
    fetch('/api/registry/agents/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'x-auth-token': K.getToken() || '' },
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.success) {
          K.showToast('Agent 已删除', 'success');
          load();
        } else {
          K.showToast(data.error || '删除失败', 'error');
        }
      })
      .catch(function (err) {
        K.showToast('删除失败: ' + err.message, 'error');
      });
  }

  global.MPViews = global.MPViews || {};
  global.MPViews.registry = {
    load: load,
    filter: filter,
    // 返回副本：外部改它不该影响本视图状态（同 alerts.events()）。
    agents: function () { return registryAgents.slice(); },
  };

  // 内联 handler 的全局出口（静态 HTML 两个 + 动态卡片五个）。见 D-017 / D-018。
  global.loadRegistryPage = load;
  global.filterRegistry = filter;
  global.showAddAgentModal = showAddModal;
  global.closeAgentModal = closeModal;
  global.saveAgent = save;
  global.editAgent = edit;
  global.deleteAgent = remove;
})(typeof window !== 'undefined' ? window : globalThis);
