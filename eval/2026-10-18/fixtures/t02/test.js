// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

const assert = require('assert');
const { parseLine } = require('./parse');

assert.deepStrictEqual(parseLine('a,"b,c",d'), ['a', 'b,c', 'd'], '引号内逗号不分隔');
assert.deepStrictEqual(parseLine('a,b,c'), ['a', 'b', 'c'], '普通行');
console.log('t02 OK');
