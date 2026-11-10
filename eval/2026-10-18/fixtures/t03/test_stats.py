# costgate — Copyright © 2026 sif-king (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
# This file is part of the costgate project.

from stats import median

assert median([1, 2, 3]) == 2, '奇数个取中间'
assert median([1, 2, 3, 4]) == 2.5, '偶数个应取中间两个的平均'
assert median([4, 4, 1, 9]) == 4, '乱序输入'
print('t03 OK')
