import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCmsAuth, isCmsReauthenticationFresh } from '../../src/cms-auth.js';
import { openDatabase } from '../../src/database.js';
import { createGovernanceService } from '../../src/governance.js';

const T0 = '2026-08-25T00:00:00.000Z';
const T1 = '2026-08-25T01:00:00.000Z';
const T2 = '2026-08-25T02:00:00.000Z';
const T3 = '2026-08-25T03:00:00.000Z';

async function withDatabase(prefix, action) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  let database;
  try {
    database = openDatabase(path.join(directory, 'test.sqlite'));
    const service = createGovernanceService(database.governance);
    return await action(database, service);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function seedUser(database, id, { role = 'member', status = 'active', displayName } = {}) {
  database.createUser({
    id,
    username: id.replaceAll('-', '_'),
    displayName: displayName ?? `用户 ${id}`,
    passwordHash: `scrypt-test-${id}`,
    createdAt: T0
  });
  database.raw.prepare('UPDATE users SET role = ?, status = ? WHERE id = ?').run(role, status, id);
  return database.governance.getUser(id);
}

function commandContext(actorUserId, createdAt, suffix) {
  return { actorUserId, createdAt, requestId: `cms-edge-${suffix}` };
}

function appError(code, status) {
  return (error) => error?.code === code && error?.status === status;
}

function invokeMiddleware(middleware, request) {
  const redirects = [];
  const nextValues = [];
  const response = {
    redirect(status, location) {
      redirects.push({ status, location });
    }
  };
  middleware(request, response, (error) => nextValues.push(error ?? null));
  return { redirects, nextValues };
}

test('CMS 再认证时间窗拒绝未来、无效和过期时间，并包含精确边界', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  const windowMs = 30 * 60 * 1000;

  assert.equal(isCmsReauthenticationFresh(null, now, windowMs), false);
  assert.equal(isCmsReauthenticationFresh({}, now, windowMs), false);
  assert.equal(isCmsReauthenticationFresh({ cmsVerifiedAt: 'not-a-date' }, now, windowMs), false);
  assert.equal(isCmsReauthenticationFresh({ cmsVerifiedAt: '2026-08-25T12:00:00.001Z' }, now, windowMs), false);
  assert.equal(isCmsReauthenticationFresh({ cmsVerifiedAt: '2026-08-25T11:30:00.000Z' }, now, windowMs), true);
  assert.equal(isCmsReauthenticationFresh({ cmsVerifiedAt: '2026-08-25T11:29:59.999Z' }, now, windowMs), false);
});

test('CMS next 只接受安全的站内绝对路径，并限制重定向值长度', () => {
  const auth = createCmsAuth({ config: { cmsReauthMs: 30 * 60 * 1000 } });

  assert.equal(auth.safeNext('/cms/cases?status=open'), '/cms/cases?status=open');
  assert.equal(auth.safeNext(`/cms/${'a'.repeat(600)}`).length, 500);
  for (const unsafe of [undefined, '', 'cms', 'https://evil.example/cms', '//evil.example/cms', '/\\evil.example']) {
    assert.equal(auth.safeNext(unsafe), '/cms');
  }

  // Encoded separators must not become a scheme-relative URL after a later decode/redirect hop.
  assert.equal(auth.safeNext('/%5cevil.example/cms'), '/cms');
  assert.equal(auth.safeNext('/%2f%2fevil.example/cms'), '/cms');
});

test('CMS 权限中间件区分未登录、成员、停用工作人员、审核员和管理员', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  const auth = createCmsAuth({
    config: { cmsReauthMs: 30 * 60 * 1000 },
    now: () => now
  });

  const anonymous = invokeMiddleware(auth.requireCmsRole, {
    currentUser: null,
    originalUrl: '/cms/cases?status=open'
  });
  assert.deepEqual(anonymous.redirects, [{
    status: 303,
    location: '/login?next=%2Fcms%2Fcases%3Fstatus%3Dopen'
  }]);
  assert.deepEqual(anonymous.nextValues, []);

  for (const currentUser of [
    { id: 'member', role: 'member', status: 'active' },
    { id: 'suspended-moderator', role: 'moderator', status: 'suspended' }
  ]) {
    const result = invokeMiddleware(auth.requireCmsRole, { currentUser, originalUrl: '/cms' });
    assert.equal(result.redirects.length, 0);
    assert.equal(result.nextValues.length, 1);
    assert.ok(appError('CMS_FORBIDDEN', 403)(result.nextValues[0]));
  }

  const moderator = { id: 'moderator', role: 'moderator', status: 'active' };
  assert.deepEqual(
    invokeMiddleware(auth.requireCmsRole, { currentUser: moderator, originalUrl: '/cms' }).nextValues,
    [null]
  );
  assert.ok(appError('ADMINISTRATOR_REQUIRED', 403)(
    invokeMiddleware(auth.requireAdministrator, { currentUser: moderator }).nextValues[0]
  ));

  const administrator = { id: 'administrator', role: 'administrator', status: 'active' };
  assert.deepEqual(
    invokeMiddleware(auth.requireAdministrator, { currentUser: administrator }).nextValues,
    [null]
  );
  assert.ok(appError('ADMINISTRATOR_REQUIRED', 403)(
    invokeMiddleware(auth.requireAdministrator, {
      currentUser: { ...administrator, status: 'suspended' }
    }).nextValues[0]
  ));

  const fresh = invokeMiddleware(auth.requireCmsReauthentication, {
    method: 'POST', originalUrl: '/cms/cases/1/claim',
    authSession: { cmsVerifiedAt: '2026-08-25T11:30:00.000Z' }
  });
  assert.deepEqual(fresh.nextValues, [null]);

  const expiredGet = invokeMiddleware(auth.requireCmsReauthentication, {
    method: 'GET', originalUrl: '//evil.example/cms',
    authSession: { cmsVerifiedAt: '2026-08-25T11:29:59.999Z' }
  });
  assert.deepEqual(expiredGet.redirects, [{ status: 303, location: '/cms/reauth?next=%2Fcms' }]);

  const expiredPost = invokeMiddleware(auth.requireCmsReauthentication, {
    method: 'POST', originalUrl: '/cms/cases/1/claim', authSession: null
  });
  assert.ok(appError('CMS_REAUTH_REQUIRED', 403)(expiredPost.nextValues[0]));
  assert.equal(expiredPost.redirects.length, 0);
});

test('分类保持最多两级，且有效子分类阻止父分类停用', async () => {
  await withDatabase('tongjian-cms-category-depth-', (database, service) => {
    const administrator = seedUser(database, 'category-admin', { role: 'administrator' });
    const root = service.createCategory({
      slug: 'root', name: '一级分类', description: '', sortOrder: 10,
      internalReason: '建立一级分类'
    }, commandContext(administrator.id, T1, 'category-root'));
    const child = service.createCategory({
      slug: 'child', name: '二级分类', description: '', parentId: root.id, sortOrder: 20,
      internalReason: '建立二级分类'
    }, commandContext(administrator.id, T2, 'category-child'));

    assert.throws(() => service.createCategory({
      slug: 'grandchild', name: '三级分类', description: '', parentId: child.id, sortOrder: 30,
      internalReason: '不应建立三级分类'
    }, commandContext(administrator.id, T3, 'category-grandchild')), appError('VALIDATION_ERROR', 400));

    assert.throws(() => service.updateCategory({
      categoryId: root.id, expectedUpdatedAt: root.updated_at,
      name: root.name, description: root.description, sortOrder: root.sort_order,
      isActive: false, internalReason: '父分类仍有有效子分类'
    }, commandContext(administrator.id, T3, 'category-disable-root')), appError('VALIDATION_ERROR', 400));

    assert.equal(database.governance.getCategory(root.id).is_active, 1);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'taxonomy.category_created'").get().count, 2);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'taxonomy.category_updated'").get().count, 0);
  });
});

test('停用的父分类不能再接受新的有效子分类', async () => {
  await withDatabase('tongjian-cms-category-inactive-parent-', (database, service) => {
    const administrator = seedUser(database, 'inactive-parent-admin', { role: 'administrator' });
    const root = service.createCategory({
      slug: 'inactive-root', name: '待停用父分类', description: '', sortOrder: 10,
      internalReason: '建立待停用父分类'
    }, commandContext(administrator.id, T1, 'inactive-parent-create'));
    const disabled = service.updateCategory({
      categoryId: root.id, expectedUpdatedAt: root.updated_at,
      name: root.name, description: root.description, sortOrder: root.sort_order,
      isActive: false, internalReason: '停用当前没有子分类的父分类'
    }, commandContext(administrator.id, T2, 'inactive-parent-disable'));
    assert.equal(disabled.is_active, 0);

    assert.throws(() => service.createCategory({
      slug: 'active-child', name: '不应创建的有效子分类', description: '',
      parentId: root.id, sortOrder: 20, internalReason: '不能挂到停用父分类下'
    }, commandContext(administrator.id, T3, 'inactive-parent-child')), appError('VALIDATION_ERROR', 400));
  });
});

test('分类更新使用 updated_at CAS，旧页面不会覆盖或追加审计', async () => {
  await withDatabase('tongjian-cms-category-cas-', (database, service) => {
    const administrator = seedUser(database, 'category-cas-admin', { role: 'administrator' });
    const category = service.createCategory({
      slug: 'immutable-slug', name: '原分类名', description: '原说明', sortOrder: 1,
      internalReason: '建立分类以测试并发控制'
    }, commandContext(administrator.id, T1, 'category-cas-create'));
    const updated = service.updateCategory({
      categoryId: category.id, expectedUpdatedAt: category.updated_at,
      name: '新分类名', description: '新说明', sortOrder: 2, isActive: true,
      internalReason: '第一次合法更新'
    }, commandContext(administrator.id, T2, 'category-cas-update'));
    assert.equal(updated.slug, 'immutable-slug');
    assert.equal(updated.updated_at, T2);

    assert.throws(() => service.updateCategory({
      categoryId: category.id, expectedUpdatedAt: category.updated_at,
      name: '过期页面名称', description: '过期说明', sortOrder: 3, isActive: true,
      internalReason: '过期页面不应覆盖'
    }, commandContext(administrator.id, T3, 'category-cas-stale')), appError('CATEGORY_VERSION_CONFLICT', 409));

    const stored = database.governance.getCategory(category.id);
    assert.equal(stored.slug, 'immutable-slug');
    assert.equal(stored.name, '新分类名');
    assert.equal(stored.updated_at, T2);
    assert.equal(database.raw.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'taxonomy.category_updated'").get().count, 1);
  });
});

test('停用标签的 slug 不能重建，合并后的旧 slug 查询给出规范重定向目标', async () => {
  await withDatabase('tongjian-cms-tag-lifecycle-', (database, service) => {
    const administrator = seedUser(database, 'tag-edge-admin', { role: 'administrator' });
    const inactive = service.createTag({
      slug: 'retired', name: '待停用标签', internalReason: '创建标签'
    }, commandContext(administrator.id, T1, 'tag-retired-create'));
    const disabled = service.updateTag({
      tagId: inactive.id, expectedUpdatedAt: inactive.updated_at,
      name: inactive.name, isActive: false, internalReason: '停用但保留旧链接'
    }, commandContext(administrator.id, T2, 'tag-retired-disable'));
    assert.equal(disabled.is_active, 0);
    assert.throws(() => service.createTag({
      slug: 'RETIRED', name: '企图重建', internalReason: '不应复用旧 slug'
    }, commandContext(administrator.id, T3, 'tag-retired-recreate')), appError('TAG_SLUG_EXISTS', 409));

    const source = service.createTag({
      slug: 'old-topic', name: '旧主题', internalReason: '创建待合并标签'
    }, commandContext(administrator.id, '2026-08-25T04:00:00.000Z', 'tag-source'));
    const target = service.createTag({
      slug: 'canonical-topic', name: '规范主题', internalReason: '创建规范标签'
    }, commandContext(administrator.id, '2026-08-25T05:00:00.000Z', 'tag-target'));
    service.mergeTag({
      sourceTagId: source.id, targetTagId: target.id,
      expectedUpdatedAt: source.updated_at, internalReason: '统一重复主题'
    }, commandContext(administrator.id, '2026-08-25T06:00:00.000Z', 'tag-merge'));

    assert.deepEqual(database.getTagBySlug('OLD-TOPIC'), {
      id: source.id,
      slug: 'old-topic',
      name: '旧主题',
      isActive: false,
      mergedIntoId: target.id,
      mergedIntoSlug: 'canonical-topic',
      mergedIntoName: '规范主题',
      updatedAt: '2026-08-25T06:00:00.000Z'
    });
    assert.equal(database.getTagBySlug('canonical-topic').isActive, true);
  });
});

test('审计查询可组合筛选操作者、动作、对象、时间并保留筛选后的总数', async () => {
  await withDatabase('tongjian-cms-audit-query-', (database, service) => {
    const administrator = seedUser(database, 'audit-admin', {
      role: 'administrator', displayName: '审计管理员'
    });
    const otherAdministrator = seedUser(database, 'audit-other', {
      role: 'administrator', displayName: '另一位管理员'
    });
    const first = service.createCategory({
      slug: 'audit-one', name: '审计分类一', description: '', sortOrder: 1,
      internalReason: '第一项审计事件'
    }, commandContext(administrator.id, T1, 'audit-one'));
    service.createCategory({
      slug: 'audit-two', name: '审计分类二', description: '', sortOrder: 2,
      internalReason: '第二项审计事件'
    }, commandContext(otherAdministrator.id, T2, 'audit-two'));
    service.updateCategory({
      categoryId: first.id, expectedUpdatedAt: first.updated_at,
      name: '审计分类一更新', description: '', sortOrder: 3, isActive: true,
      internalReason: '第三项审计事件'
    }, commandContext(administrator.id, T3, 'audit-three'));

    const byActorAndObject = database.governance.listAudit({
      actor: 'AUDIT_ADMIN', objectType: 'category', objectId: String(first.id),
      from: T1, to: T3, limit: 1, offset: 0
    });
    assert.equal(byActorAndObject.total, 2);
    assert.equal(byActorAndObject.items.length, 1);
    assert.equal(byActorAndObject.items[0].action, 'taxonomy.category_updated');
    assert.equal(byActorAndObject.items[0].actorUserId, administrator.id);
    assert.equal(byActorAndObject.items[0].objectId, String(first.id));

    const exactAction = database.governance.listAudit({
      actorUserId: otherAdministrator.id,
      action: 'taxonomy.category_created',
      objectType: 'category', from: T2, to: T2
    });
    assert.equal(exactAction.total, 1);
    assert.equal(exactAction.items[0].actorUsername, 'audit_other');
    assert.deepEqual(exactAction.items[0].after, {
      slug: 'audit-two', name: '审计分类二', parentId: null, sortOrder: 2, isActive: true
    });

    // LIKE 通配符来自用户输入时必须按字面量处理。
    assert.equal(database.governance.listAudit({ actor: '%' }).total, 0);
    assert.equal(database.governance.listAudit({ actor: '_____' }).total, 0);
  });
});

test('本地 CLI 领域授权幂等，且只以 system-cli 写入一次动作、审计和通知', async () => {
  await withDatabase('tongjian-cms-cli-grant-', (database, service) => {
    const member = seedUser(database, 'first-admin');

    const granted = service.grantAdministratorByUsername('  FIRST_ADMIN  ', {
      createdAt: T1, requestId: 'cli-first-grant'
    });
    assert.equal(granted.id, member.id);
    assert.equal(granted.role, 'administrator');
    assert.equal(granted.governance_version, 1);

    const repeated = service.grantAdministratorByUsername('first_admin', {
      createdAt: T2, requestId: 'cli-repeated-grant'
    });
    assert.equal(repeated.role, 'administrator');
    assert.equal(repeated.governance_version, 1);

    const actions = database.raw.prepare(`
      SELECT * FROM moderation_actions
      WHERE affected_user_id = ? AND action = 'user_role'
    `).all(member.id);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].actor_user_id, null);
    assert.equal(actions[0].actor_label, 'system-cli');
    assert.deepEqual(JSON.parse(actions[0].before_json), {
      role: 'member', status: 'active', governanceVersion: 0
    });
    assert.deepEqual(JSON.parse(actions[0].after_json), {
      role: 'administrator', status: 'active', governanceVersion: 1
    });

    const audits = database.raw.prepare(`
      SELECT * FROM audit_events
      WHERE object_type = 'user' AND object_id = ? AND action = 'user.role_changed'
    `).all(member.id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_user_id, null);
    assert.equal(audits[0].actor_label, 'system-cli');
    assert.equal(audits[0].request_id, 'cli-first-grant');
    assert.deepEqual(JSON.parse(audits[0].metadata_json), { source: 'admin:grant' });

    assert.equal(database.raw.prepare(`
      SELECT count(*) AS count FROM notifications
      WHERE recipient_user_id = ? AND type = 'system'
    `).get(member.id).count, 1);
  });
});
