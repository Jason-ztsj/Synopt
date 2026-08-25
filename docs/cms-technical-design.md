# 同见 CMS V1 技术设计

本文记录已落地的 CMS V1 边界，并与当前表结构、领域命令和路由保持一致。CMS V1 是现有 Node.js、Express、EJS、SQLite 单体中的独立 `/cms` 工作区，不引入通用 CRUD API，也不让后台绕过媒体验证、作者可见性或文件删除流程。

## 1. 目标与非目标

V1 要交付一条可追责、可申诉、可并发处理的最小治理闭环：成员举报，工作人员认领和调查，工作人员对视频、讨论或账号作出有理由的决定，受影响成员收到通知并可在期限内申诉，管理员可检查不可由后台删除的审计记录。

CMS 不是第二份业务数据库。公开视频、讨论正文、账号、标签、验证任务和删除队列仍以现有表为唯一事实来源；治理表只记录案件、决定、申诉、授权和审计。CMS 不能把视频直接改成技术验证通过，不能同步删除媒体文件，不能恢复作者主动删除的讨论或作者主动撤回/设为私密的视频。

V1 继续使用 `created_at DESC, id DESC` 的确定性排序，不实现推荐算法配置。未来只有在存在第二种真实算法后，才扩展“算法版本—离线校验—预览—发布—公开说明—回滚”链路。

## 2. 角色、权限与账号状态

角色是代码中的固定枚举，不提供动态权限编辑器。

| 能力 | member | moderator | administrator |
| --- | --- | --- | --- |
| 举报可见内容、查看本人举报 | 是 | 是 | 是 |
| 对涉及本人的可申诉不利决定申诉 | 是 | 是 | 是 |
| 进入 CMS、处理案件、审核视频/讨论 | 否 | 是 | 是 |
| 在案件内申请私密媒体授权 | 否 | 是 | 是 |
| 复核非本人作出的视频/讨论决定 | 否 | 是 | 是 |
| 管理账号状态/角色、分类/标签、任务、除本人利益冲突对象外的全量审计 | 否 | 否 | 是 |

审核员的 CMS 首页可看到 `validation_failed` 视频的必要内容摘要，并跳到其本就有权访问的 CMS 视频列表；但无权重试。对删除队列，审核员只看到匿名失败总数，不会收到任务目标、存储文件名、错误内容或任务链接。`/cms/tasks`、两类任务重试、`/cms/users` 和经过本人利益冲突过滤的全量审计仍只限管理员。

工作人员同时也是普通成员、内容作者、举报人和潜在申诉人，角色提升不能消除本人利益冲突。隔离按“目标”而不是按某一案件计算：工作人员只要曾举报某视频或讨论，就不能再通过另一条举报或主动调查案件读取、认领、转交、审核或复核该目标；也不能被选为该目标的负责人或申诉复核人。举报过某位作者内容的管理员不能进入或治理该作者账号。案件、内容、账号、申诉、近期动作和审计查询都应用同一边界；讨论详情的回复树仍保留结构，但涉及本人或本人举报的节点会遮蔽正文、作者、状态和链接。相关详情返回 404，伪造写请求返回 403，筛选参数不能撤销隔离。底层 `audit_events` 仍完整追加，普通索引最多显示无内部证据的摘要。

`active` 账号拥有其角色允许的正常能力。`suspended` 账号仍可用密码建立会话，但服务端只允许浏览公开内容、访问本人举报与申诉页、提交申诉、修改密码和退出；上传、投票、发言、资料修改和 CMS 均拒绝。`disabled` 账号不能登录；V1 的 CMS 不提供禁用动作。

管理员不能暂停自己或降低自己的角色。任何操作都不能暂停、降级或注销最后一名 `active` 管理员；账号自助注销也在事务中复核这一约束。暂停会立即撤销目标账号的全部现有会话；角色在每个请求中从数据库会话联表重新读取，因此撤权对旧 Cookie 立即生效。

## 3. 二次认证与私密媒体边界

CMS 沿用站点会话和 CSRF 机制。拥有工作人员角色还不够：进入任何 CMS 页面或动作前，会话的 `cms_verified_at` 必须处于 `CMS_REAUTH_MINUTES` 窗口内。密码复核尝试使用 `AUTH_COOLDOWN_SECONDS` 作为冷却时间，同时按当前工作人员账号和按 `CLIENT_IP_MODE` 解析的来源地址在单进程内计算；密码正确与否都会消耗这次尝试。重新输入密码成功后，只更新属于当前工作人员的当前会话，并记录审计；修改角色或账号状态不会依赖 Cookie 内缓存。

私密、未列出、作者撤回或被治理隐藏/移除的视频，在普通 CMS 列表中只显示治理需要的元数据和占位封面。工作人员要么先认领以该视频为目标的案件，要么先填写调查理由创建主动调查案件再认领。只有 `in_review` 案件的当前负责人可以申请授权；申请还必须携带当前案件 `expectedVersion`，旧页面遇到备注、转交或结案会以 409 失败。转交或结案会在同一事务中删除该案件的旧授权。授权写入 `cms_media_access_grants`，同时绑定当前负责人的会话散列、案件和视频，并在 `CMS_PRIVATE_MEDIA_GRANT_MINUTES` 后过期。每次显式授权或续期写一条审计；后续 GET、HEAD 和单段 Range 请求只读取授权，不因视频分片重复写审计。每次读取仍会联表复核“会话属于授权人、案件目标匹配且仍由该人负责、账号与角色有效、授权未过期、授权人未举报该目标”。任一条不满足时，专用媒体路由不返回资源；授权也不会让未通过技术验证的文件变得可播放。

## 4. schema v5

迁移只增加字段、表、索引和只追加保护触发器，保留 v4 数据。旧讨论迁移后为 `visible`，所有治理版本从 0 开始。

- `sessions.cms_verified_at`：当前会话最近一次 CMS 密码复核时间。
- `videos.moderation_version`：视频治理 CAS 版本；现有 `moderation_status` 继续表示 `visible | hidden | removed`。
- `discussions.moderation_status`、`discussions.moderation_version`：治理占位状态与 CAS 版本；作者删除继续由 `deleted_at` 表示。
- `users.governance_version`：角色和账号状态 CAS 版本。
- `tags.is_active`、`tags.merged_into_id`、`tags.updated_at`：标签停用、合并目标和修改时间。slug 不改；旧 slug 可重定向至合并目标。
- `moderation_cases`：`report | investigation` 来源、恰好一个视频或讨论目标、举报分类/说明、举报人、负责人、`open | in_review | resolved` 状态、`violation_confirmed | no_violation` 结果、公开说明、版本和时间戳。部分唯一索引确保同一举报人对同一目标最多一个未结案件。
- `case_notes`：案件内只追加备注，保存作者和时间。
- `moderation_actions`：只追加的领域决定；恰好一个视频、讨论或账号目标，保存受影响用户、动作、公开理由、内部备注、治理字段的前后 JSON、前后版本、案件和操作者。
- `appeals`：每个审核动作最多一条，保存申诉人、理由、`pending | in_review | resolved`、`upheld | overturned`、复核人、公开说明、冲突标记、版本和时间。
- `audit_events`：只追加审计，保存操作者或 `system-cli`、request ID、动作、对象、治理前后 JSON、必要元数据和时间；不保存密码散列、Cookie、CSRF、媒体内容或无关个人资料。
- `cms_media_access_grants`：会话、案件、视频、授权人、理由和过期时间的短时授权。

`moderation_cases` 的目标检查约束、`moderation_actions` 的目标检查约束、申诉唯一约束和标签自合并检查由数据库强制执行。部分唯一索引限制同一举报人对同一目标最多一个未结案件，会话—案件—视频组合的授权也是唯一的。`case_notes`、`moderation_actions` 和 `audit_events` 还有拒绝 UPDATE/DELETE 的触发器。应用层再验证标签合并目标是未合并的有效标签、分类最多两级和最后管理员规则。

所有 CMS 写操作仍完整追加到 `audit_events`；上面的本人利益冲突过滤只是管理员读取 `/cms/audit` 时不可绕过的查询边界，并不删除、篡改或漏写底层记录。

## 5. 状态机与公开语义

案件只允许 `open → in_review → resolved`。只有未分配的 `open` 案件可认领；认领后工作人员成为当前负责人。内容作者不能为自己的内容创建主动调查、认领或处理案件；任何曾举报同一目标的工作人员也不能借另一案件处理目标，案件不能转给目标作者或任一同目标举报人。除了显式的转交例外，认领后的案件动作不因管理员角色自动越权：只有当前负责人能追加内部备注、对目标执行隐藏/移除/恢复、申请私密媒体授权或结案。当前负责人可以转交案件，管理员可以从当前负责人手中介入转交，但两者都必须选择另一名有效且独立的工作人员并给出理由。结案必须给出公开说明，结果只能是确认违规或无违规；选择“无违规”时，目标必须已恢复为 `visible`。举报人可看到状态、结果和公开说明，不能看到负责人身份、内部备注或敏感证据；父视频之后变为私密、撤回或不可见时，讨论举报页也只显示中性标题。

视频治理状态为 `visible ↔ hidden`、`visible|hidden → removed`、`hidden|removed → visible`。恢复只修改治理维度：技术验证仍须是可播放状态，作者的 `visibility`、`withdrawn_at` 和 `deleted_at` 不变。媒体文件不会由审核动作进入物理删除。

讨论治理状态同样是 `visible | hidden | removed`。公开渲染时 `hidden` 显示“正在审核”占位，`removed` 显示规则移除墓碑，回复树保留；原正文只在 CMS 中可见。作者主动删除由 `deleted_at` 和匿名墓碑表示，CMS 恢复命令不得清除它。

作者编辑或删除也不能绕过申诉和证据保留。视频永久删除以及讨论编辑/删除只能在治理状态为 `visible`、不存在未结案件或未结申诉时执行。若最近 `APPEAL_WINDOW_DAYS` 内有可申诉的隐藏/移除动作且申诉尚未结束（包括还没有提交申诉），上述编辑/删除同样被拒绝。有治理历史的讨论即使没有回复也保留墓碑行，避免外键证据被物理清除。账号注销中的“一并删除内容”选项复用同一组约束，不会把受保护的治理证据级联删除。

账号 V1 只允许 `active ↔ suspended`。角色只允许 `member | moderator | administrator`，受最后管理员与禁止自降级规则约束；CMS 不提供 `disabled` 动作，公开账号注销路径同样不能删除最后一名有效管理员。

只有 `video_hide`、`video_remove`、`discussion_hide`、`discussion_remove` 和 `user_suspend` 是 V1 可申诉动作。申诉必须在原动作后 `APPEAL_WINDOW_DAYS` 内提交，且动作的 `affected_user_id` 是当前成员；每个动作最多一条申诉。申诉状态为 `pending → in_review → resolved`：必须先由有权复核人认领，之后只有当前 `reviewer_user_id` 能以最新版本提交维持或撤销结果。当前复核人可以转交，管理员也可以介入转交；新复核人仍必须满足目标类型的角色与独立性约束。视频和讨论申诉可由审核员或管理员复核，账号暂停申诉只能由管理员查看、认领和复核。申诉人、任何同目标举报人，以及举报过账号目标作者内容的管理员均不得复核。复核优先避开原操作者；只有排除这些冲突者后不再有其他有效复核人，且仅剩一名有效管理员时，才允许该管理员复核自己的决定，并额外写冲突审计。维持决定只关闭申诉；撤销决定以原动作的 `after_version` 和 `after_json` 对事实表做 CAS。若已有后续治理动作，首次撤销不覆盖新事实，而是让申诉留在 `in_review` 并标出冲突。已认领的复核人随后必须同时携带最新申诉版本和目标版本，显式选择“恢复原动作前状态”或“保留当前后续状态”；成功后追加 `appeal_overturn` 动作、审计和通知，再以 `overturned` 结案。

## 6. 领域命令、事务与错误

所有治理写操作进入领域服务，并在单个 `BEGIN IMMEDIATE` 事务内重新读取操作者与目标、执行状态变化和写入审计；任何一步失败都回滚。会改变视频、讨论或账号状态的决定，还在同一事务内追加 `moderation_actions` 并创建强制系统通知。举报、调查、案件备注、分类标签变更、任务重试、再认证和媒体授权只写它们需要的事实与审计，不伪造一条内容审核决定。

视频、讨论、账号、案件和申诉表单携带 `expectedVersion`；分类、标签和删除队列重试用 `expectedUpdatedAt` 作为同样的 CAS 令牌。内部案件备注也不是无条件 INSERT：命令会用页面中的案件 `expectedVersion` 条件更新 `moderation_cases.version`，成功后才在同一事务内追加 `case_notes`，所以转交、结案或另一条备注与旧页面并发时会得到 409。创建命令没有旧版本；验证失败重试同时提交 `expectedValidatedAt` 与 `expectedValidationStartedAt`，SQL 比较双时间戳和 `validation_failed` 状态，防止旧页面在任务经历“重试—再次失败”的 ABA 后覆盖新失败；删除队列重试同时检查任务 `updated_at` 和失败状态。过期版本或已变化的状态返回 409，不静默覆盖。

主要命令包括：创建举报/调查案件、认领/转交/备注/结案、审核视频、审核讨论、暂停/恢复账号、撤销会话、设置角色、创建和更新分类、更新/停用/合并标签、重试失败验证或删除任务、授予私密媒体访问，以及提交/认领/转交/复核/人工解决申诉冲突。命令使用动作语义，而不是暴露任意字段更新。

统一领域错误为：400 输入无效，401 会话失效或 CMS 密码错误，403 权限/二次认证/账号状态不允许，404 对象不存在或对调用者不可见，409 版本或状态冲突，429 举报或 CMS 密码复核冷却。未登录的浏览器访问 CMS 会以 303 转到登录页。每个请求生成随机 UUID request ID，写入 `X-Request-Id` 响应头，并传入审计。两类 429 都包含 `Retry-After`；举报冷却使用 `REPORT_COOLDOWN_SECONDS` 并同时按登录账号和来源地址计算，CMS 密码复核冷却使用 `AUTH_COOLDOWN_SECONDS` 并同时按工作人员账号和来源地址计算，来源地址均按 `CLIENT_IP_MODE` 解析，状态只保存在单进程内存中。

## 7. HTTP 与模块边界

- `src/governance-store.js`：v5 查询、映射和 `BEGIN IMMEDIATE` 事务适配器。
- `src/governance.js`：固定角色能力、输入规则和领域命令。
- `src/governance-routes.js`：举报、本人举报与申诉页面/表单。
- `src/cms-auth.js`：CMS 角色、管理员能力和二次认证中间件。
- `src/cms.js`：独立 CMS Router、工作台页面和媒体授权读取。
- `src/database.js`：迁移并把治理存储适配器附加到现有数据库对象。

公开写接口使用 EJS 表单：`POST /videos/:id/reports`、`POST /discussions/:id/reports` 和 `POST /account/appeals`。成员在 `GET /account/reports` 查看本人举报，在 `GET /account/appeals` 查看涉及本人的完整治理决定公开理由、已有申诉状态和当前仍可申诉的动作。决定表保留最多 2,000 字的完整公开说明；系统通知受既有表约束只保存前 1,000 个 Unicode 字符作为预览。

CMS 的实际页面与动作路由是：

- 会话与工作台：`GET|POST /cms/reauth`、`GET /cms`。
- 案件：`GET /cms/cases`、`GET /cms/cases/:id`、`POST /cms/cases/investigations`，以及 `POST /cms/cases/:id/claim|transfer|notes|resolve|media-grants`。认领、转交、追加备注、媒体授权和结案都使用案件版本 CAS；备注、内容动作、媒体授权与结案还会重新检查当前负责人。
- 视频与讨论：`GET /cms/videos|discussions`、`GET /cms/videos|discussions/:id`，以及各自的 `POST .../:id/hide|remove|restore`。内容动作必须带与目标匹配的未结案件 ID。
- 授权媒体：`GET|HEAD /cms/videos/:id/media?caseId=:caseId`，仅接受有效授权和已通过技术验证的视频。
- 申诉：`GET /cms/appeals`、`GET /cms/appeals/:id`，以及 `POST /cms/appeals/:id/claim|transfer|review|resolve-conflict`；`.../resolve` 是 `review` 的兼容路径。只有 `pending` 申诉可认领，只有当前复核人可从 `in_review` 提交结果；认领、转交和复核均使用申诉版本 CAS，人工冲突处理还同时使用目标版本 CAS。
- 管理员专用：`/cms/users`、`/cms/taxonomy`、`/cms/tasks`、`/cms/audit`。账号动作为 `suspend|restore|role|sessions/revoke`；分类和标签支持创建、更新、启停用及标签合并；任务重试为 `POST /cms/tasks/videos/:id/retry` 和 `POST /cms/tasks/deletions/:id/retry`。

成功写入使用 PRG 303；输入、权限或冲突错误保留对应 HTTP 状态并渲染后台错误页，密码复核失败则以 401 重新渲染复核页。所有 CMS 响应都是 `Cache-Control: no-store` 并带 `X-Robots-Tag: noindex, nofollow`。

## 8. 失败恢复、备份与迁移

启动迁移在事务中执行并在提交前运行 `PRAGMA foreign_key_check`。生产升级前应停止写流量并复制 SQLite 主文件及同目录 WAL/SHM，或使用 SQLite 在线备份命令生成一致备份；升级后核对 `PRAGMA user_version = 5`、外键检查、管理员数量和队列状态。程序不自动降级；回滚代码前应恢复升级前一致备份。

验证失败重试只能把 `validation_failed` 改回 `pending`，并以页面读取的验证完成/开始双时间戳做 CAS；验证工作进程仍是唯一能写入 `ready` 或 `ready_with_warnings` 的组件。删除任务重试只把 `attempt_count > 0` 且 `updated_at` 仍与页面一致的现有任务 `next_attempt_at` 提前，文件删除仍由原队列消费者完成。审核员首页可获得验证失败视频的必要内容摘要，但不获得任务动作；对删除失败则只获得匿名总数。完整任务明细和两类重试表单只在管理员的 `/cms/tasks` 页面出现。命令以当前状态与 CAS 令牌更新，重复提交不会伪造成功状态；唯一索引为未结举报和申诉提供数据库级重复保护。

## 9. 验收与测试边界

当前自动测试包括真实 v4→v5 迁移、案件目标/唯一性/外键/只追加触发器，以及领域服务的举报去重、案件 CAS、视频/讨论决定、通知、最后管理员保护、暂停会话、申诉回避与撤销冲突、标签合并和验证重试。EJS 渲染测试检查版本、理由、私密媒体和管理员界面；HTTP 流程测试检查成员/审核员/管理员权限、本人利益冲突隔离、再认证、CSRF、举报冷却、内容决定、暂停账号与短时媒体授权。HTTP 集成测试必须在允许监听本地临时端口的环境运行，并与全部现有账号、上传、投票、讨论、通知和媒体测试一起复跑。
