// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// byGroup(rows) 把 rows 按 group 字段累加 cost，缺 group 的归到 'unknown'
function byGroup(rows) {
  const out = {};
  for (const r of rows) {
    out[r.group] = (out[r.group] || 0) + r.cost;
  }
  return out;
}

module.exports = { byGroup };
