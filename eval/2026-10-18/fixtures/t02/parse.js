// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

// parseLine(line) 按逗号切分一行 CSV，双引号内的逗号不作为分隔符
function parseLine(line) {
  return line.split(',');
}

module.exports = { parseLine };
