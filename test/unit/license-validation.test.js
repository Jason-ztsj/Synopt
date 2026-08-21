import assert from 'node:assert/strict';
import test from 'node:test';

import { getLicense, normalizeLicense } from '../../src/license.js';
import { ValidationError } from '../../src/errors.js';
import {
  FIELD_LIMITS,
  validateDiscussionBody,
  validateVideoFields
} from '../../src/validation.js';

test('许可证选择的五种有效组合映射到精确的 Creative Commons 代码和官方链接', () => {
  const cases = [
    {
      input: {},
      id: 'CC0-1.0',
      code: 'CC0 1.0',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/deed.zh-hans'
    },
    {
      input: { attribution: 'on' },
      id: 'CC-BY-4.0',
      code: 'CC BY 4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/deed.zh-hans'
    },
    {
      input: { attribution: true, nonCommercial: '1' },
      id: 'CC-BY-NC-4.0',
      code: 'CC BY-NC 4.0',
      url: 'https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans'
    },
    {
      input: { attribution: 1, noDerivatives: 'true' },
      id: 'CC-BY-ND-4.0',
      code: 'CC BY-ND 4.0',
      url: 'https://creativecommons.org/licenses/by-nd/4.0/deed.zh-hans'
    },
    {
      input: { attribution: 'on', non_commercial: 'on', no_derivatives: 'on' },
      id: 'CC-BY-NC-ND-4.0',
      code: 'CC BY-NC-ND 4.0',
      url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/deed.zh-hans'
    }
  ];

  for (const expected of cases) {
    const license = normalizeLicense(expected.input);
    assert.equal(license.id, expected.id);
    assert.equal(license.code, expected.code);
    assert.equal(license.url, expected.url);
    assert.equal(getLicense(license.id), license);
  }
  assert.equal(getLicense('not-a-license'), null);
});

test('未选择署名时后端忽略伪造的 NC/ND 值并强正规范化为 CC0', () => {
  for (const input of [
    { nonCommercial: 'on' },
    { noDerivatives: true },
    { attribution: 'off', nonCommercial: 'on', noDerivatives: 'on' },
    { attribution: false, non_commercial: 1, no_derivatives: 1 }
  ]) {
    const license = normalizeLicense(input);
    assert.equal(license.id, 'CC0-1.0');
    assert.equal(license.cc0, true);
    assert.match(license.summary, /无需署名|公共领域/);
  }
});

test('视频字段会去除首尾空白，并接受精确上限和空描述', () => {
  const fields = validateVideoFields({
    title: `  ${'题'.repeat(FIELD_LIMITS.title)}  `,
    creator: `\n${'作'.repeat(FIELD_LIMITS.creator)}\t`,
    description: '   '
  });
  assert.equal(fields.title.length, 120);
  assert.equal(fields.creator.length, 80);
  assert.equal(fields.description, '');

  const longestDescription = '述'.repeat(FIELD_LIMITS.description);
  assert.equal(validateVideoFields({ title: '题', creator: '作', description: longestDescription }).description, longestDescription);
});

test('视频字段拒绝缺少必填项、超出边界和 NUL 字符', () => {
  const base = { title: '标题', creator: '创作者', description: '' };
  const invalidInputs = [
    [{ ...base, title: '   ' }, /视频标题/],
    [{ ...base, creator: undefined }, /创作者署名/],
    [{ ...base, title: '题'.repeat(FIELD_LIMITS.title + 1) }, /120/],
    [{ ...base, creator: '作'.repeat(FIELD_LIMITS.creator + 1) }, /80/],
    [{ ...base, description: '述'.repeat(FIELD_LIMITS.description + 1) }, /2[,.]?000/],
    [{ ...base, description: '前\0后' }, /非法字符/]
  ];

  for (const [input, message] of invalidInputs) {
    assert.throws(
      () => validateVideoFields(input),
      (error) => error instanceof ValidationError && error.status === 400 && message.test(error.message)
    );
  }
});

test('讨论正文边界与页面 5,000 字符契约一致', () => {
  assert.equal(FIELD_LIMITS.discussion, 5000);
  assert.equal(validateDiscussionBody(`  ${'回'.repeat(5000)}  `).length, 5000);
  assert.throws(() => validateDiscussionBody(' '), ValidationError);
  assert.throws(() => validateDiscussionBody('回'.repeat(5001)), /5[,.]?000/);
  assert.throws(() => validateDiscussionBody('回\0应'), /非法字符/);
});

