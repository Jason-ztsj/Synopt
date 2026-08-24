import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ejs from 'ejs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viewsRoot = path.join(projectRoot, 'views');

const account = Object.freeze({
  id: 'account-view-user',
  username: 'view_author',
  displayName: '页面测试作者',
  bio: '用于账号页面渲染测试。',
  avatarStorageName: 'avatar.webp',
  avatarMediaType: 'image/webp',
  status: 'active',
  createdAt: '2026-08-23T10:00:00.000Z',
  updatedAt: '2026-08-23T10:30:00.000Z'
});

const commonLocals = Object.freeze({
  currentUser: account,
  csrfToken: 'render-test-csrf-token',
  notificationUnreadCount: 3,
  categoryTree: [],
  popularTags: [],
  categories: [],
  flash: '',
  error: ''
});

async function render(view, locals = {}) {
  return ejs.renderFile(path.join(viewsRoot, `${view}.ejs`), {
    ...commonLocals,
    ...locals
  });
}

test('账号中心和公开主页可用真实页面参数完整渲染', async () => {
  const profile = await render('account-profile', {
    account,
    form: account,
    stats: { videoCount: 1, discussionCount: 2, receivedUpvoteCount: 3 },
    avatarRules: { maxBytes: 2 * 1024 * 1024 }
  });
  assert.match(profile, /data-account-menu/);
  assert.match(profile, /action="\/account\/profile"/);
  assert.match(profile, /href="\/account\/videos"/);
  assert.match(profile, /退出登录/);

  const videos = await render('account-videos', {
    account,
    videos: [{
      id: 'view-video',
      title: '页面测试稿件',
      creator: '页面测试作者',
      validationStatus: 'ready',
      moderationStatus: 'visible',
      visibility: 'public',
      coverStorageName: 'cover.webp',
      upvoteCount: 4,
      downvoteCount: 1,
      discussionCount: 2,
      createdAt: '2026-08-23T11:00:00.000Z'
    }],
    pagination: { page: 1, total: 1, totalPages: 1 }
  });
  assert.match(videos, /action="\/account\/videos\/view-video\/withdraw"/);
  assert.match(videos, /页面测试稿件/);

  const settings = await render('account-settings', {
    account,
    form: {},
    stats: {},
    notificationPreferences: { reply: true, videoVote: false, system: true }
  });
  assert.match(settings, /action="\/account\/settings\/password"/);
  assert.match(settings, /action="\/account\/delete"/);
  assert.match(settings, /data-browser-notification-settings/);

  const notifications = await render('account-notifications', {
    account,
    notifications: [{
      id: 7,
      type: 'reply',
      count: 1,
      isRead: false,
      title: '有人回复了你的讨论',
      summary: '来自《页面测试稿件》的讨论',
      link: '/videos/view-video#discussion-2',
      createdAt: '2026-08-23T12:00:00.000Z'
    }],
    pagination: { page: 1, total: 1, totalPages: 1 }
  });
  assert.match(notifications, /action="\/account\/notifications\/7\/read"/);
  assert.match(notifications, /有人回复了你的讨论/);

  const publicProfile = await render('public-profile', {
    account,
    profile: { ...account, videoCount: 1, discussionCount: 2, receivedUpvoteCount: 3 },
    stats: { videoCount: 1, discussionCount: 2, receivedUpvoteCount: 3 },
    videos: [{
      id: 'view-video',
      title: '页面测试稿件',
      creator: '页面测试作者',
      licenseCode: 'CC-BY-4.0',
      categoryName: '科学与技术',
      coverStorageName: 'cover.webp',
      tags: [{ slug: 'test', name: '测试' }],
      createdAt: '2026-08-23T11:00:00.000Z'
    }],
    pagination: { page: 1, total: 1, totalPages: 1 }
  });
  assert.match(publicProfile, /@view_author/);
  assert.match(publicProfile, /href="\/videos\/view-video"/);
});

test('我的讨论复用完整编辑器且每条公式对话框 ID 唯一', async () => {
  const discussions = [1, 2].map((id) => ({
    id,
    videoId: 'view-video',
    videoTitle: '页面测试稿件',
    userId: account.id,
    title: id === 1 ? '测试主题' : '测试回复',
    parentId: id === 1 ? null : 1,
    bodyMarkdown: `讨论正文 ${id}`,
    renderedBody: `<p>讨论正文 ${id}</p>`,
    editCount: id,
    editedAt: '2026-08-23T13:00:00.000Z',
    replyCount: id === 1 ? 1 : 0,
    upvoteCount: 2,
    downvoteCount: 0,
    createdAt: '2026-08-23T12:00:00.000Z'
  }));
  const html = await render('account-discussions', {
    account,
    discussions,
    pagination: { page: 1, total: 2, totalPages: 1 },
    includeMathEditor: true
  });

  assert.match(html, /id="account-edit-1-formula-dialog"/);
  assert.match(html, /id="account-edit-2-formula-dialog"/);
  assert.equal((html.match(/data-formula-editor/g) || []).length, 2);
  assert.equal((html.match(/name="title"/g) || []).length, 2);
  assert.equal((html.match(/name="body"/g) || []).length, 2);
});
