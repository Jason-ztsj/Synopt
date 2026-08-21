import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateCsrfToken,
  generateSessionToken,
  hashCsrfToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
  verifyCsrfToken,
  verifyPassword
} from '../../src/auth.js';

test('用户名会执行 NFKC 规范化、去除边缘空白并统一为小写', () => {
  assert.equal(normalizeUsername('  Alice_DEV  '), 'alice_dev');
  assert.equal(normalizeUsername('Ａｌｉｃｅ-１２３'), 'alice-123');
  assert.equal(normalizeUsername(undefined), '');
});

test('scrypt 密码哈希使用随机盐、可验证正确密码并安全拒绝坏数据', async () => {
  const password = '正确马电池订书钉';
  const [firstHash, secondHash] = await Promise.all([
    hashPassword(password),
    hashPassword(password)
  ]);

  assert.match(firstHash, /^scrypt\$1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword(password, firstHash), true);
  assert.equal(await verifyPassword('错误密码', firstHash), false);
  assert.equal(await verifyPassword(password, 'not-a-password-hash'), false);
  assert.equal(await verifyPassword(password, firstHash.replace('$16384$', '$999999$')), false);
  assert.equal(await verifyPassword(password, firstHash.replace(/\$([^$]+)$/, '$not+base64')), false);
  assert.equal(await verifyPassword(password, `${firstHash}=`), false);
  assert.equal(await verifyPassword(null, firstHash), false);
  await assert.rejects(() => hashPassword(''), TypeError);
});

test('会话与 CSRF 使用高熵不透明令牌，持久层哈希确定且 CSRF 比较拒绝篡改', () => {
  const firstSessionToken = generateSessionToken();
  const secondSessionToken = generateSessionToken();
  assert.match(firstSessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(firstSessionToken, secondSessionToken);
  assert.match(hashSessionToken(firstSessionToken), /^[a-f0-9]{64}$/);
  assert.equal(hashSessionToken(firstSessionToken), hashSessionToken(firstSessionToken));

  const csrfToken = generateCsrfToken();
  const csrfHash = hashCsrfToken(csrfToken);
  assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(csrfHash, /^[a-f0-9]{64}$/);
  assert.equal(verifyCsrfToken(csrfToken, csrfHash), true);
  assert.equal(verifyCsrfToken(`${csrfToken}x`, csrfHash), false);
  assert.equal(verifyCsrfToken(csrfToken, 'invalid'), false);
  assert.equal(verifyCsrfToken(null, csrfHash), false);
  assert.throws(() => hashSessionToken(''), TypeError);
});
