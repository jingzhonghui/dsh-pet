/**
 * React #62 回归：`style` 必须是对象，不能是字符串。
 *
 * 本仓库的 `h` 直接来自 `react/jsx-runtime`，字符串 style 会在渲染时抛
 * “The `style` prop expects a mapping from style properties to values, not a string”，
 * 结果是整个设置区挂载失败、页面空白。这里做一次源码扫描，成本低、能挡住同类低级错误。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

test('client 源码不把 style 写成字符串（React #62）', () => {
  const offenders: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts') || name.endsWith('.test.ts')) continue;
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (/\bstyle\s*:\s*['"]/.test(line)) offenders.push(`${name}:${index + 1}: ${trimmed}`);
    });
  }
  assert.deepEqual(offenders, []);
});
