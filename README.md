# 同见

“同见”是一个面向开放知识与非营利视频分享的实验性 MVP：任何人都可以浏览视频；注册并登录后，可以上传 MP4、选择 Creative Commons 许可证，并用 Markdown、LaTeX 和公式键盘参与讨论。项目优先考虑简洁、自行托管、ARM64 开发板和本地资源，不依赖外部数据库或运行时 CDN。

当前只有中文名“同见”，正式英文名尚未确定。仓库里的 `gongying` 等旧内部标识暂时保留用于兼容，不代表新的英文品牌。

> 这是一次产品与技术尝试，目前没有实际运营或开放公网服务的计划。账号功能只解决实验阶段的身份连续性，不应被理解为已经具备生产平台所需的账号治理、内容审核与合规能力。

## 当前功能

- 首页按上传时间倒序公开展示视频，观看不要求登录。
- 用户名、显示名称和密码注册；登录后使用稳定账号身份，退出会撤销当前会话。
- 只有登录用户能上传视频或发布讨论；既有 MVP 数据会原样保留，迁移前的内容可能没有关联账号。
- 上传标题、创作者署名、可选描述和 MP4 文件；支持 CC0 1.0、CC BY 4.0、CC BY-NC 4.0、CC BY-ND 4.0、CC BY-NC-ND 4.0。
- 原生播放器支持 `GET`、`HEAD` 和单段 HTTP Range，可播放并拖动进度。
- 讨论支持安全渲染的 Markdown、行内/块级 LaTeX 和实时预览。
- 讨论编辑器集成本地 MathLive 公式键盘，可通过模板插入行内或块级公式，并利用数学输入框的结构化光标移动编辑公式；保存格式仍是便于迁移的 Markdown/LaTeX 文本。
- 讨论同时按账号和来源 IP 限流；注册、登录也有短暂的来源 IP 冷却。应用不保存或展示 IP。
- SQLite 保存账号、会话、视频元数据和讨论，视频文件保存在独立目录。

账号与安全相关的当前边界：

- 密码使用 Node.js `scrypt` 加随机盐保存，不存储明文密码。
- 浏览器只保存随机会话令牌；数据库保存它的 SHA-256 摘要。会话默认有效 168 小时。
- 注册、登录、退出、上传和发布讨论等写操作均校验 CSRF 令牌；会话与 CSRF Cookie 使用 `HttpOnly`、`SameSite=Lax`，HTTPS 部署时还应启用 `Secure`。
- 当前没有邮箱验证、密码找回、修改密码、多因素认证、会话管理、封禁、审核后台、删除、配额或内容举报。
- 账号与讨论限流都在单进程内存中，重启后清空，多实例之间也不共享。

## 技术要求

- Node.js 24 LTS
- npm（随 Node.js 提供）
- Docker Engine 与 Docker Compose 插件（仅容器部署需要）

应用使用 Node.js 内置 `node:sqlite`，无需安装 SQLite 服务或编译原生数据库扩展。MathLive 和 KaTeX 都由 npm 安装并从本机提供，浏览器运行时不访问 CDN。官方 Node 24 slim 镜像支持常见的 AMD64 和 ARM64 Linux 主机。

## 本机运行

```bash
git clone <你的仓库地址> nonprofit-video-mvp
cd nonprofit-video-mvp
cp .env.example .env
npm ci
node --env-file=.env src/index.js
```

打开 `http://127.0.0.1:3000`。应用进程会监听 `0.0.0.0`，这是为了方便无显示器开发板通过局域网调试；本机仍可用回环地址访问。应用启动时会创建数据目录并执行向后兼容的数据库迁移，不会删除既有视频或讨论。

Node 的 `--env-file` 参数负责读取 `.env`；如果完全使用默认值，也可运行 `npm start`。所有配置都会在启动时校验，非法值会令进程立即退出并给出错误。

运行测试：

```bash
npm test
```

也可分别运行：

```bash
npm run test:unit
npm run test:integration
```

测试覆盖配置与输入边界、密码和安全令牌、数据库迁移、许可证规范化、Markdown/XSS、MP4 文件头、客户端 IP、冷却窗口，以及真实 HTTP 注册、登录、退出、CSRF、上传、清理、Range 和讨论流程。

[`docs/qa/README.md`](docs/qa/README.md) 中的截图和记录是账号功能加入前的历史 MVP 基线，不能替代当前版本的复验。

## 配置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口，必须是 1–65535 的整数。 |
| `HOST_BIND_ADDRESS` | `127.0.0.1` | 仅供 Compose 使用的宿主机发布地址；不改变 Node 进程在容器内的监听地址。 |
| `DATABASE_PATH` | `./data/gongying.sqlite` | SQLite 数据库路径；旧文件名为兼容既有 MVP 数据而保留。 |
| `VIDEO_STORAGE_PATH` | `./data/videos` | 已验证视频及同文件系统上传临时文件的存储目录。 |
| `MAX_UPLOAD_MB` | `90` | 单个视频上传上限，单位 MiB，必须为正数。 |
| `DISCUSSION_COOLDOWN_SECONDS` | `30` | 同一账号或来源 IP 两次讨论之间的最短秒数。 |
| `AUTH_COOLDOWN_SECONDS` | `2` | 同一来源 IP 两次注册尝试或两次登录尝试之间的最短秒数。 |
| `SESSION_TTL_HOURS` | `168` | 登录会话有效期，最大 8760 小时。 |
| `SESSION_COOKIE_SECURE` | `false` | 是否为会话和 CSRF Cookie 添加 `Secure`；仅通过 HTTPS 访问时应设为 `true`。 |
| `CLIENT_IP_MODE` | `direct` | `direct` 或 `cloudflare`，决定限流使用的客户端地址来源。 |

通过 `node --env-file=.env` 启动时，已有进程环境变量优先于 `.env` 中的同名值；Compose 也会读取项目根目录的 `.env`。不要提交 `.env`、数据库或视频文件。

## Docker Compose（含 ARM64）

先复制配置并创建宿主数据目录。容器以非 root 的 `node` 用户（UID/GID 1000）运行，因此数据目录必须可由该用户写入：

```bash
cp .env.example .env
mkdir -p data/videos
docker compose build
docker compose up -d
docker compose ps
```

服务默认只发布在 `127.0.0.1:${PORT}`。Compose 将 `./data` 挂载到 `/app/data`，数据库、账号和视频不随容器重建而消失。如果主机上的 UID/GID 不是 1000，或出现 `EACCES`，请将 `data` 的所有者调整为容器用户：

```bash
sudo chown -R 1000:1000 data
```

查看日志或停止服务：

```bash
docker compose logs -f app
docker compose down
```

`docker compose down` 不会删除 `./data`。镜像基于多架构 `node:24-bookworm-slim`；在 ARM64 主机上直接构建即可。若要在另一台机器显式构建 ARM64 镜像：

```bash
docker buildx build --platform linux/arm64 -t tongjian-video-mvp:arm64 --load .
```

这里的 `tongjian-video-mvp` 只是本地镜像标签，并非正式英文产品名。镜像与 Compose 都使用 `/healthz` 健康检查；服务健康后该接口返回 HTTP 200。

## 局域网开发板调试

直接运行 Node 时，应用已经监听 `0.0.0.0`。在开发板上启动后，同一局域网的其他设备可打开 `http://<开发板局域网地址>:3000`。

使用 Compose 时，`HOST_BIND_ADDRESS` 决定宿主机在哪些地址发布端口。可先用下面的命令找到开发板地址：

```bash
ip -brief -4 address show scope global
```

然后选择其一写入 `.env` 并重建容器：

```dotenv
# 只发布到一个明确的 LAN 地址
HOST_BIND_ADDRESS=192.168.10.24

# 或为了无显示器设备的临时调试，发布到所有网卡
HOST_BIND_ADDRESS=0.0.0.0
```

```bash
docker compose up -d --force-recreate
```

`0.0.0.0` 是有意支持的开发调试配置，但它也会覆盖 VPN、隧道等其他网卡。只应在可信局域网内使用，配合防火墙将 TCP 3000 限制在本地子网，并且不要做公网端口转发。它不等于公网生产部署方案。

## Cloudflare Tunnel（仅供后续实验）

如果以后通过 Cloudflare Tunnel 试验 HTTPS 访问，推荐让宿主端口继续绑定 `127.0.0.1`，由同机的 `cloudflared` 连接 `http://localhost:3000`。确认源站不能被绕过后，设置：

```dotenv
HOST_BIND_ADDRESS=127.0.0.1
CLIENT_IP_MODE=cloudflare
SESSION_COOKIE_SECURE=true
```

两种 IP 模式的信任边界：

- `direct` 只使用 TCP 连接地址并忽略代理头，适合局域网直接访问。
- `cloudflare` 会读取合法的单值 `CF-Connecting-IP`，缺失或非法时回退到连接地址。直接访问者可以伪造这个请求头，因此启用该模式时必须让源站只能经受信 Tunnel 到达。

隧道或反向代理可能另有请求体限制。默认 `MAX_UPLOAD_MB=90` 已为 `multipart/form-data` 开销预留空间；试验前仍应核对当时所用入口服务和套餐的限制。

## 视频兼容性

平台仅接收并直接提供 MP4。它检查扩展名、MIME 类型和 MP4 的 `ftyp` 文件头，但不会探测内部编码、转码或生成备用清晰度。

为了覆盖大多数现代手机和桌面浏览器，建议上传 H.264 视频加 AAC 音频的 MP4，并使用适合网络播放的 fast-start 布局。通过文件头检查并不保证任意编码都能在浏览器中播放。

## 备份、迁移与恢复

数据库启动迁移会给旧视频和讨论增加可空的账号关联，并保留旧数据。默认数据库仍叫 `gongying.sqlite`，只是兼容性文件名；不要为了改品牌手工改名后只迁走数据库而遗漏视频。

一致备份应短暂停止应用并复制整个 `data` 目录，以同时保留 SQLite 数据库、WAL 辅助文件（若存在）、账号、会话和所有视频：

```bash
docker compose stop app
tar -czf "tongjian-backup-$(date +%Y%m%d-%H%M%S).tar.gz" data
docker compose start app
```

恢复到空目录时：

```bash
docker compose down
mv data data.before-restore
tar -xzf tongjian-backup-YYYYMMDD-HHMMSS.tar.gz
sudo chown -R 1000:1000 data
docker compose up -d
```

恢复后先检查 `/healthz`，再抽查登录、视频播放与拖动、许可证、账号归属和讨论。备份中的服务端会话记录可能仍有效，但浏览器还需要原会话 Cookie；无法确认信任边界时，应将会话视为敏感数据。确认恢复无误前保留 `data.before-restore`。

## 当前版本验收清单

自动测试通过后，建议至少人工检查：

1. 未登录时可以浏览和播放，访问 `/upload` 会转到登录页。
2. 注册后立即成为登录状态；刷新页面后会话仍有效，用户名大小写不能重复注册。
3. 登录用户可以上传视频，首页和详情页能显示账号归属；旧视频仍可访问。
4. 讨论以账号显示名称发布，公式键盘能插入行内与块级 LaTeX，结构化输入和实时预览均正常。
5. 缺失或错误 CSRF 令牌的写请求被拒绝；讨论冷却同时作用于账号和来源 IP。
6. 退出后不能上传或发布讨论，使用正确密码重新登录后恢复权限。
7. 手机与桌面宽度均无页面级横向溢出，长公式只在公式区域内滚动。
8. 重启进程或容器后，账号、视频和讨论仍存在；完整媒体、`HEAD` 和单段 Range 响应正常。

## 公网部署前须知

注册和登录并不使当前 MVP 适合实际运营。公开部署仍可能遭遇违法或侵权内容、垃圾账号、密码攻击、恶意文件、流量滥用和磁盘耗尽。当前也没有邮箱所有权验证、密码重置、账号恢复、内容删除、审核、封禁、存储配额、备份保留策略或事件响应流程。

如果未来决定运营，应先单独设计治理与安全方案，并至少加入入口层限流、TLS、监控告警、数据库与媒体备份策略、账号生命周期、审核/举报/删除、内容与法律政策。不要把这份实验代码直接暴露到公网。

## 许可证行为

上传页默认勾选“署名”。取消署名时，“非商业使用”和“禁止演绎”会同时清空并禁用，最终使用 CC0 1.0；后端会再次规范化，不能靠伪造表单绕过。CC0 视频仍记录并展示必填的创作者名称，但使用者无需署名。其余组合映射为对应的 CC 4.0 官方许可证，详情页会显示中文说明及官方 `rel="license"` 链接。

## 数据与隐私

SQLite 持久化用户名、显示名称、带盐密码摘要、会话/CSRF 令牌摘要、视频元数据，以及讨论的账号关联、显示名称快照、Markdown 原文和时间；视频二进制文件单独保存。应用只在内存中短暂使用客户端 IP 做注册、登录和讨论冷却，不把 IP 写入数据库或页面。

应用不会索取邮箱或真实姓名。讨论正文最多 5,000 个字符。页面响应包含限制脚本、媒体和表单来源的 Content Security Policy，以及防止 MIME 嗅探、页面嵌入和敏感来源泄露的基础安全响应头。
