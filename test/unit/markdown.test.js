import assert from 'node:assert/strict';
import test from 'node:test';

import { ValidationError } from '../../src/errors.js';
import {
  MAX_MATH_EXPRESSIONS,
  MAX_MATH_LENGTH,
  renderMarkdown
} from '../../src/markdown.js';

test('Markdown 支持粗体、链接、列表以及行内和块级 LaTeX', () => {
  const html = renderMarkdown([
    '**重要内容**',
    '',
    '[资料链接](https://example.com/read)',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '行内公式 $E=mc^2$。',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx',
    '$$'
  ].join('\n'));

  assert.match(html, /<strong>重要内容<\/strong>/);
  assert.match(html, /<ul>[\s\S]*<li>第一项<\/li>[\s\S]*<li>第二项<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /class="math-block"/);

  const anchor = html.match(/<a\s+[^>]*href="https:\/\/example\.com\/read"[^>]*>/)?.[0];
  assert.ok(anchor, '应渲染用户链接');
  const rel = anchor.match(/rel="([^"]+)"/)?.[1]?.split(/\s+/) ?? [];
  assert.deepEqual(new Set(rel), new Set(['ugc', 'nofollow', 'noopener']));
});

test('Markdown 禁止原始 HTML、危险链接和图片注入', () => {
  const html = renderMarkdown([
    '<script>alert("xss")</script>',
    '',
    '<img src=x onerror=alert(1)>',
    '',
    '[危险链接](javascript:alert(1))',
    '',
    '![追踪像素](https://example.com/pixel.gif)'
  ].join('\n'));

  // Event-handler text is harmless after HTML escaping; what must never survive
  // is an executable element or a dangerous href attribute.
  assert.doesNotMatch(html, /<script\b|<img\b|href="javascript:/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /追踪像素/);
});

test('KaTeX 使用不信任模式，过长公式降级且公式数量有硬限制', () => {
  const untrusted = renderMarkdown('$\\href{javascript:alert(1)}{点击}$');
  assert.doesNotMatch(untrusted, /href="javascript:/i);

  const longFormula = renderMarkdown(`$${'x'.repeat(MAX_MATH_LENGTH + 1)}$`);
  assert.match(longFormula, /math-error/);
  assert.match(longFormula, /公式过长/);

  const tooMany = '$x$ '.repeat(MAX_MATH_EXPRESSIONS + 1);
  assert.throws(
    () => renderMarkdown(tooMany),
    (error) => error instanceof ValidationError && /最多包含 50 个公式/.test(error.message)
  );
});
