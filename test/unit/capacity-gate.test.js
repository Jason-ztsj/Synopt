import assert from 'node:assert/strict';
import test from 'node:test';

import { CapacityGate } from '../../src/capacity-gate.js';
import { AppError } from '../../src/errors.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('并发达到上限时立即拒绝且不会调用额外任务', async () => {
  const gate = new CapacityGate({ limit: 2, cooldownSeconds: 17 });
  const first = deferred();
  const second = deferred();
  let rejectedActionCalled = false;

  const firstRun = gate.run(() => first.promise);
  const secondRun = gate.run(() => second.promise);
  assert.equal(gate.active, 2);

  await assert.rejects(
    gate.run(() => {
      rejectedActionCalled = true;
    }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'IMAGE_NORMALIZATION_BUSY');
      assert.equal(error.retryAfterSeconds, 17);
      return true;
    }
  );
  assert.equal(rejectedActionCalled, false);
  assert.equal(gate.active, 2);

  first.resolve('first-result');
  assert.equal(await firstRun, 'first-result');
  assert.equal(gate.active, 1);
  assert.equal(await gate.run(() => 'next-result'), 'next-result');

  second.resolve('second-result');
  assert.equal(await secondRun, 'second-result');
  assert.equal(gate.active, 0);
});

test('任务抛错时也释放容量', async () => {
  const gate = new CapacityGate({ limit: 1 });
  const expected = new Error('normalize failed');

  await assert.rejects(gate.run(() => {
    throw expected;
  }), (error) => error === expected);

  assert.equal(gate.active, 0);
  assert.equal(await gate.run(async () => 42), 42);
  assert.equal(gate.active, 0);
});

test('构造参数与任务必须有效', async () => {
  assert.throws(() => new CapacityGate({ limit: 0 }), /limit/);
  assert.throws(() => new CapacityGate({ cooldownSeconds: 1.5 }), /cooldownSeconds/);
  const gate = new CapacityGate();
  await assert.rejects(gate.run(null), /action/);
  assert.equal(gate.active, 0);
});
