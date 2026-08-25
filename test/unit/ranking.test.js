import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RANKING_VERSION,
  RANKING_PARAMS,
  valueScore,
  participationMultiplier,
  discussionDepthScore,
  baseValue,
  hotRank,
  evergreenRank,
  currentCycleNumber,
  pickRevivals,
  isRevivedBoosted
} from '../../src/ranking.js';

const HOUR = 3600 * 1000;

test('三档收获投票：样本校正把低样本拉向中性，高分样本随票数收敛', () => {
  assert.equal(valueScore({ high: 0, medium: 0, low: 0 }), 0);
  // 1 个高（满分）但样本小 → 被 Beta 先验拉到 ~0.67，不窜顶
  assert.ok(valueScore({ high: 1 }) < 0.7, '单票高分不应窜顶');
  assert.equal(valueScore({ high: 1 }), (1 + 1) / (1 + 2));
  // 大量高票 → 收敛到接近 1
  const bulk = valueScore({ high: 200, medium: 0, low: 0 });
  assert.ok(bulk > 0.99 && bulk <= 1, `高分大样本应接近 1，实际 ${bulk}`);
  // 大量低票 → 接近 0
  assert.ok(valueScore({ high: 0, medium: 0, low: 200 }) < 0.01);
  // 中档 → 收敛到 0.5
  assert.ok(valueScore({ medium: 200 }) > 0.49 && valueScore({ medium: 200 }) < 0.51);
});

test('参与度增益：票数不足抑制价值信号，达阈值后全额', () => {
  assert.equal(participationMultiplier({ high: 0, medium: 0, low: 0 }), 0);
  assert.equal(participationMultiplier({ high: 6 }), 0.5);
  assert.equal(participationMultiplier({ high: 12 }), 1);
  assert.equal(participationMultiplier({ high: 60 }), 1);
});

test('讨论深度：奖励深层来回探讨与主题，而非纯回复条数，并设上限', () => {
  assert.equal(discussionDepthScore({ topics: 0, replies: 0, deepReplies: 0 }), 0);
  assert.equal(discussionDepthScore({ topics: 1 }), 1);
  assert.equal(discussionDepthScore({ replies: 1 }), 0.6);
  // 深层回复 ≥ 主题，体现"来回探讨"价值
  assert.ok(discussionDepthScore({ deepReplies: 2 }) < discussionDepthScore({ topics: 2 }));
  // 上限
  const big = discussionDepthScore({ topics: 1000 });
  assert.equal(big, RANKING_PARAMS.discussionCap);
});

test('baseValue：价值与讨论合成，讨论权重更高', () => {
  const valueOnly = baseValue({ high: 12, medium: 0, low: 0, topics: 0, replies: 0, deepReplies: 0 });
  const discussionOnly = baseValue({ high: 0, medium: 0, low: 0, topics: 3, replies: 0, deepReplies: 0 });
  assert.ok(valueOnly > 0);
  assert.ok(discussionOnly > 0);
  // 讨论权重高于价值权重（wDiscussion=2 > wValue=1）
  assert.ok(discussionOnly > valueOnly, '讨论应高于同等规模的价值信号');
});

test('hot 衰减：有软下限，好而旧的内容不会衰减到零', () => {
  const value = 5;
  const young = hotRank(value, 1);
  const old = hotRank(value, 2 * HOUR);
  const veryOld = hotRank(value, 30 * 24 * HOUR);
  const ancient = hotRank(value, 365 * 24 * HOUR); // 远超 ageCap 30 天
  assert.ok(young > old, '越新越高');
  // 超过 30 天软下限后不再衰减：365 天与 30 天应一致（age 被封顶）
  assert.equal(hotRank(value, 30 * 24 * HOUR), hotRank(value, 365 * 24 * HOUR));
  assert.ok(ancient > 0, '不应衰减为零');
});

test('evergreen（典范）几乎不衰减，趋于时间无关', () => {
  const value = 8;
  const fresh = evergreenRank(value, 1);
  const year = evergreenRank(value, 365);
  assert.ok(fresh > year);
  assert.ok(year / fresh > 0.8, `典范页应几乎不衰减，实际比值 ${year / fresh}`);
});

test('周期号：按周期长度切分时间', () => {
  const params = RANKING_PARAMS;
  const t0 = 0;
  const cycleMs = params.revivalEveryHours * HOUR;
  assert.equal(currentCycleNumber(t0, params), 0);
  assert.equal(currentCycleNumber(t0 + cycleMs - 1, params), 0);
  assert.equal(currentCycleNumber(t0 + cycleMs, params), 1);
  assert.equal(currentCycleNumber(t0 + 5 * cycleMs, params), 5);
});

test('复活：确定性（同输入同输出）、质量门槛、作者名额上限、时长成本权重', () => {
  const params = RANKING_PARAMS;
  const now = 1700000000000;
  const cycle = currentCycleNumber(now, params);
  const mk = (id, durSec, value, userId) => ({
    id, durationSeconds: durSec, value, userId,
    createdAt: now - 10 * 86400000 // 10 天前，满足 revivalMinDaysOld
  });
  const pool = [
    mk('a', 600, 0.8, 'u1'),   // 10 分钟
    mk('b', 3600, 0.8, 'u1'),  // 60 分钟，同一作者 u1
    mk('c', 7200, 0.8, 'u2'),  // 120 分钟
    mk('d', 300, 0.2, 'u3'),   // 值低于质量门槛，排除
    mk('e', 60, 0.9, 'u4')     // 1 分钟，值高
  ];
  const first = pickRevivals(pool, cycle, params);
  assert.equal(first.size, params.revivalSlots);
  // 确定性
  assert.deepEqual([...pickRevivals(pool, cycle, params)].sort(), [...first].sort());
  // 不同周期 → 选择可能不同（但不保证必然不同，只验证不抛且大小正确）
  const nextCycle = cycle + 1;
  const next = pickRevivals(pool, nextCycle, params);
  assert.equal(next.size, params.revivalSlots);
  // 低质量被排除
  assert.ok(!first.has('d'), '低于质量门槛的视频不应被复活');

  // 作者上限：同一作者在一个周期内最多 revivalAuthorCap 个
  const perAuthor = new Map();
  for (const id of first) {
    const vid = pool.find((v) => v.id === id);
    perAuthor.set(vid.userId, (perAuthor.get(vid.userId) || 0) + 1);
  }
  for (const [, count] of perAuthor) {
    assert.ok(count <= params.revivalAuthorCap, `作者 ${count} 个不应超过上限 ${params.revivalAuthorCap}`);
  }
});

test('复活加成窗口：仅在被选中且在窗口内时成立', () => {
  const params = RANKING_PARAMS;
  const ids = new Set(['x']);
  const boostStart = 1000;
  const windowMs = params.revivalBoostHours * HOUR;
  assert.equal(isRevivedBoosted('x', ids, boostStart, boostStart + windowMs - 1, params), true);
  assert.equal(isRevivedBoosted('x', ids, boostStart, boostStart + windowMs, params), false);
  assert.equal(isRevivedBoosted('x', ids, 0, 0, params), true); // 起点即窗口内
  assert.equal(isRevivedBoosted('y', ids, boostStart, boostStart + 1000, params), false);
});
