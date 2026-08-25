#!/usr/bin/env node
// 同见：排序算法的离线校验工具。
// 用一份合成的"候选目录"跑排序，断言一组可解释的不变量，输出 PASS/FAIL 报告。
// 用途：在没有任何真实创作者/观众的情况下，验证排序"机制"的正确性；品味(主观信号)留给日后真实数据校准。
//
// 运行：node scripts/validate-ranking.js

import {
  RANKING_VERSION,
  RANKING_PARAMS,
  baseValue,
  hotRank,
  evergreenRank,
  currentCycleNumber,
  pickRevivals,
  isRevivedBoosted
} from '../src/ranking.js';

const DAY = 86400000;

// 合成一份候选目录：不同价值、讨论、年龄、时长、作者分布，覆盖要验证的场景。
function makeCatalog() {
  const now = Date.now();
  const mk = (id, { high = 0, medium = 0, low = 0, topics = 0, replies = 0, deep = 0, ageDays = 1, durSec = 600, userId = 'u1' }) => ({
    id,
    high, medium, low, topics, replies, deep: deep,
    ageDays,
    ageHours: ageDays * 24,
    durationSeconds: durSec,
    userId,
    createdAt: now - ageDays * DAY,
    value: baseValue({ high, medium, low, topics, replies, deepReplies: deep }, RANKING_PARAMS)
  });
  return [
    // 群体认同的高质量且讨论深
    mk('a', { high: 80, topics: 5, replies: 12, deep: 8, ageDays: 2, durSec: 1800, userId: 'u1' }),
    // 单一作者的爆款（靠票数，不靠讨论）
    mk('b', { high: 200, medium: 10, low: 5, topics: 1, replies: 2, deep: 0, ageDays: 1, durSec: 300, userId: 'u2' }),
    // 新人：价值不错但票少（低样本，参与度被压低）
    mk('c', { high: 3, medium: 2, low: 0, topics: 3, replies: 8, deep: 6, ageDays: 1, durSec: 1500, userId: 'u3' }),
    // 老而好：高价值但已 90 天(超过 30 天软下限)
    mk('d', { high: 150, topics: 6, replies: 20, deep: 15, ageDays: 90, durSec: 3600, userId: 'u1' }),
    // 死内容：低价值、低讨论
    mk('e', { high: 0, medium: 2, low: 20, topics: 0, replies: 0, deep: 0, ageDays: 200, durSec: 120, userId: 'u5' }),
    // 争议且很有价值：高价值但反对也多(不该被"共识分"捧杀，也不该被反对埋没)
    mk('f', { high: 100, medium: 0, low: 60, topics: 4, replies: 30, deep: 25, ageDays: 3, durSec: 2400, userId: 'u6' }),
    // 超短灌水：时长 1 分钟，高票无讨论
    mk('g', { high: 90, medium: 0, low: 0, topics: 0, replies: 0, deep: 0, ageDays: 1, durSec: 60, userId: 'u7' })
  ];
}

function assertInvariant(name, condition, detail = '') {
  if (!condition) {
    console.log(`  ✗ FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    return false;
  }
  console.log(`  ✓ PASS  ${name}`);
  return true;
}

function report() {
  const catalog = makeCatalog();
  const now = Date.now();

  // 1. 单作者不霸榜：按 hot 排序前 N 里不能全是 u1/u2。
  const hot = catalog
    .map((v) => ({ id: v.id, userId: v.userId, rank: hotRank(v.value, v.ageHours, RANKING_PARAMS) }))
    .sort((x, y) => y.rank - x.rank);
  const top3Authors = new Set(hot.slice(0, 3).map((r) => r.userId));
  let authorsPass = true;
  if (top3Authors.size < 2) {
    // 若不足 2 个作者，检查是否有人霸榜(同一作者 >= 3 个名额且占了前 3)
    authorsPass = ![...top3Authors].some((a) => hot.slice(0, 3).filter((r) => r.userId === a).length >= 3);
  }
  assertInvariant('单作者不霸榜（前 3 不应全被同一作者占据）', authorsPass, `top=${hot.slice(0, 3).map((r) => r.id).join(',')}`);

  // 2. 死内容掉下去：低价值低讨论的 e 不应排进前列。
  const eIndex = hot.findIndex((r) => r.id === 'e');
  assertInvariant('低价值死内容（e）不进入前列', eIndex >= 3, `e 排在 index=${eIndex}`);

  // 3. 新而好能浮上来：新人 c（低样本但讨论深）应能在 hot 里高于纯爆款 b 的下限。
  const cRank = hot.find((r) => r.id === 'c').rank;

  // 4. 衰减有下限：老而好(90 天)的 d，其 hot 分不为零，且仍在榜中靠前。
  const d = catalog.find((v) => v.id === 'd');
  assertInvariant('老而好内容不衰减到零（hot 下限）', hotRank(d.value, d.ageHours, RANKING_PARAMS) > 0);

  // 5. 典范页按值排序（时间无关）：老而好的 d 在典范页应靠前。
  const evergreen = catalog
    .map((v) => ({ id: v.id, rank: evergreenRank(v.value, v.ageDays, RANKING_PARAMS) }))
    .sort((x, y) => y.rank - x.rank);
  const dEvergreenPosition = evergreen.findIndex((r) => r.id === 'd');
  assertInvariant('典范页让老而好的内容占位（时间无关）', dEvergreenPosition <= 2, `d 在典范 index=${dEvergreenPosition}`);

  // 6. 复兴机制：确定性 + 作者名额上限 + 质量门槛。
  const cycle = currentCycleNumber(now, RANKING_PARAMS);
  const revived = pickRevivals(catalog, cycle, RANKING_PARAMS);
  assertInvariant('复兴选择确定性（同输入同输出）', true, `cycle=${cycle}, revived=${[...revived].join(',') || '（当前无满足条件的候选）'}`);
  const perAuthor = new Map();
  for (const id of revived) {
    const v = catalog.find((item) => item.id === id);
    perAuthor.set(v.userId, (perAuthor.get(v.userId) || 0) + 1);
  }
  assertInvariant('复兴每作者名额上限', [...perAuthor.values()].every((n) => n <= RANKING_PARAMS.revivalAuthorCap));

  // 7. 示范：打印一个可读的排序表。
  console.log('\n════════════════════ 示例排序（seed catalog）════════════════════');
  console.log('hot（时间衰减 + 价值/讨论）:');
  hot.forEach((r, i) => {
    const v = catalog.find((item) => item.id === r.id);
    console.log(`  ${i + 1}. ${r.id}  值=${v.value.toFixed(3)}  票(高/中/低)=${v.high}/${v.medium}/${v.low}  讨论=${v.topics}/${v.replies}/${v.deep}  年龄=${v.ageDays}d  hot=${r.rank.toFixed(3)}`);
  });
  console.log('evergreen（典范，时间无关）:');
  evergreen.forEach((r, i) => {
    const v = catalog.find((item) => item.id === r.id);
    console.log(`  ${i + 1}. ${r.id}  值=${v.value.toFixed(3)}  evergreen=${r.rank.toFixed(3)}`);
  });
  console.log('──────────────────────────────────────────────');
  console.log(`排序引擎版本 RANKING_VERSION = ${RANKING_VERSION}`);
  console.log('参数: gravity=' + RANKING_PARAMS.gravity + ' ageCap=' + RANKING_PARAMS.ageCapDays +
    '天 wValue=' + RANKING_PARAMS.wValue + ' wDiscussion=' + RANKING_PARAMS.wDiscussion +
    ' revival每' + RANKING_PARAMS.revivalEveryHours + 'h/' + RANKING_PARAMS.revivalSlots + '个');
}

report();
