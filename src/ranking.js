// 同见：公开、可复算、版本化的内容排序。
// 一切公式、参数、输入字段都以本模块为单一事实来源。`/algorithm` 页从本模块直接渲染，
// 保证"页面描述的是真实运行代码"，而非营销承诺。
//
// 设计要点（详见 docs/algorithm.md）：
//   - 值(value)：衡量"内容有没有让人学到/思考"，由三档"收获"投票(样本校正) + 讨论深度组成。
//   - 时间衰减：hot 榜单有软下限(ageCap)，好内容不会被时间清零；evergreen(典范)页按值排序、时间基本无关。
//   - 复活：旧而好的内容有确定性、公开、限时的"重新被发现"机制，且时长成本权重让高创作成本内容多点机会。

export const RANKING_VERSION = 1;

export const RANKING_PARAMS = Object.freeze({
  // 价值信号：三档收获投票(高/中/低) 样本校正 + 参与度下限
  valueHighScore: 1.0,
  valueMediumScore: 0.5,
  valueLowScore: 0.0,
  valuePriorAlpha: 1.0, // Beta 先验（样本校正，低样本被拉向中性）
  valuePriorBeta: 1.0,
  valueParticipationFull: 12, // 达到该投票人数后价值信号才全额计入
  // 讨论深度
  wValue: 1.0,
  wDiscussion: 2.0, // 讨论深度是平台身份，权重高
  discussionCap: 30,
  discussionTopicWeight: 1.0, // 一个顶层讨论主题
  discussionReplyWeight: 0.6, // 对主题的直接回复
  discussionDeepWeight: 0.4, // 深度 >= 2 的回复（真正的来回探讨）
  // 时间衰减
  gravity: 1.5,
  ageCapDays: 30, // hot 的软下限：超过后不再继续衰减
  hourOffset: 2,
  evergreenGravity: 0.02, // 典范页几乎不衰减（仅保留极小的新近倾向用于稳定排序）
  // 复活机制（确定性随机 + log 时长成本权重）
  revivalEveryHours: 6,
  revivalSlots: 2,
  revivalBoostHours: 24,
  revivalBoostFactor: 1.6, // 复活后在 hot 榜的固定加成
  revivalMinDaysOld: 3,
  revivalMaxDaysOld: 3650,
  revivalMinValue: 0.45, // 质量门槛：低于此不参与复活
  revivalAuthorCap: 1, // 每周期每作者最多复活几个
  revivalDurationWeight: 0.25 // log(分钟) 的成本加权强度
});

export const RANKING_INPUTS = Object.freeze([
  '该视频的三档价值投票计数（高 / 中 / 低）',
  '该视频的讨论结构（顶层主题数、直接回复数、深层回复数）',
  '视频发布后的年龄（小时）',
  '视频时长（仅用于复活机制的创作成本权重）',
  '视频作者（仅用于复活机制的作者名额上限）'
]);

export const RANKING_NOT_USED = Object.freeze([
  '用户身份 / 账号信息',
  '观看历史或观看序列',
  '任何服务端用户画像、兴趣推断或人口属性',
  '浏览次数 / 播放量（当前未采集，也不用于排序）',
  '点赞之外的任何货币化或推广信号'
]);

// 确定性字符串哈希（FNV-1a 32 位），用于复活的选择——可复算、不可操控。
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashUnit(str) {
  return fnv1a(str) / 0xffffffff;
}

// 三档"收获"投票的样本校正均值（Beta 先验），返回 0..1。
// 低样本会被拉向中性（0.5），避免"少数人全高分"或"少数人全低分"窜顶。
export function valueScore({ high = 0, medium = 0, low = 0 }, params = RANKING_PARAMS) {
  const n = high + medium + low;
  if (n < 1) return 0;
  const sum = high * params.valueHighScore + medium * params.valueMediumScore + low * params.valueLowScore;
  return (sum + params.valuePriorAlpha) / (n + params.valuePriorAlpha + params.valuePriorBeta);
}

// 参与度增益：投票人数足够后才让价值信号全额计入；少数人的判断权重被压低。
export function participationMultiplier({ high = 0, medium = 0, low = 0 }, params = RANKING_PARAMS) {
  const n = high + medium + low;
  if (n < 1) return 0;
  return Math.min(1, n / params.valueParticipationFull);
}

// 讨论深度：奖励"真正的来回探讨"（深层回复 + 主题），而非纯回复条数。
export function discussionDepthScore({ topics = 0, replies = 0, deepReplies = 0 }, params = RANKING_PARAMS) {
  const raw = topics * params.discussionTopicWeight
    + replies * params.discussionReplyWeight
    + deepReplies * params.discussionDeepWeight;
  return Math.min(params.discussionCap, raw);
}

// 该视频的"值"（质量分）：价值投票 + 讨论深度，二者合成为非负分。
export function baseValue({ high, medium, low, topics, replies, deepReplies }, params = RANKING_PARAMS) {
  const value = valueScore({ high, medium, low }, params) * participationMultiplier({ high, medium, low }, params);
  return params.wValue * value + params.wDiscussion * discussionDepthScore({ topics, replies, deepReplies }, params);
}

// hot 榜：时间衰减，但有软下限（不超过 ageCapDays 后不再衰减）。
// 年龄以小时计（与 HN 一致），ageCap 从"天"换算。
export function hotRank(value, ageHours, params = RANKING_PARAMS) {
  const ageCapHours = params.ageCapDays * 24;
  const age = Math.min(Number(ageHours) || 0, ageCapHours);
  return value / Math.pow(age + params.hourOffset, params.gravity);
}

// 典范（evergreen）榜：时间基本无关，仅保留极小的新近倾向用于相同价值的稳定排序。
export function evergreenRank(value, ageDays, params = RANKING_PARAMS) {
  return value / Math.pow(Math.min(Number(ageDays) || 0, 730) + 1, params.evergreenGravity);
}

// 当前复活周期号：把时间轴切成固定周期，决定"这一轮该复活谁"。
export function currentCycleNumber(nowMs, params = RANKING_PARAMS) {
  const cycleMs = params.revivalEveryHours * 3600 * 1000;
  return Math.floor((Number(nowMs) || 0) / cycleMs);
}

// 从候选里确定性选出本周期要复活的视频（质量门槛内随机 + log 时长成本加权），
// 并遵守"每作者每周期名额上限"。返回复活视频 id 集合。
export function pickRevivals(videos, cycleNumber, params = RANKING_PARAMS) {
  const eligible = videos.filter((video) => {
    const ageDays = (Date.now() - video.createdAt) / 86400000;
    return video.value >= params.revivalMinValue
      && ageDays >= params.revivalMinDaysOld
      && ageDays <= params.revivalMaxDaysOld;
  });
  const scored = eligible.map((video) => {
    const minutes = Math.max(1, (video.durationSeconds || 0) / 60);
    const costWeight = Math.log(minutes) * params.revivalDurationWeight;
    const ticket = hashUnit(`${video.id}:${cycleNumber}`);
    return { id: video.id, authorId: video.userId, score: costWeight + ticket };
  }).sort((a, b) => b.score - a.score);

  const chosen = [];
  const perAuthor = new Map();
  for (const item of scored) {
    if (chosen.length >= params.revivalSlots) break;
    const authorCount = perAuthor.get(item.authorId) || 0;
    if (authorCount >= params.revivalAuthorCap) continue;
    perAuthor.set(item.authorId, authorCount + 1);
    chosen.push(item.id);
  }
  return new Set(chosen);
}

// 判断某视频当前是否处于复活加成窗口（本周期被选中且尚未过窗口）。
export function isRevivedBoosted(videoId, revivedIds, boostStartedAtMs, nowMs, params = RANKING_PARAMS) {
  if (!revivedIds.has(videoId)) return false;
  const windowMs = params.revivalBoostHours * 3600 * 1000;
  if (typeof boostStartedAtMs !== 'number') return true; // 未提供起点则视为正处于窗口
  return (Number(nowMs) - boostStartedAtMs) < windowMs;
}
