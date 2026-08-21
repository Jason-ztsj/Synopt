# 共映

“共映”是一个面向非营利视频分享场景的最小可用平台：公开匿名上传 MP4、选择 Creative Commons 许可证、在线播放，并以 Markdown 和 LaTeX 参与讨论。它以单机、ARM64 友好和可自行托管为优先，不依赖外部数据库、前端框架或运行时 CDN。

## 功能范围

- 首页按上传时间倒序展示视频。
- 上传标题、创作者署名、可选描述和 MP4 文件。
- 五种授权结果：CC0 1.0、CC BY 4.0、CC BY-NC 4.0、CC BY-ND 4.0、CC BY-NC-ND 4.0。
- 原生播放器支持 `GET`、`HEAD` 和单段 HTTP Range，可播放并拖动进度。
- 讨论支持安全渲染的 Markdown、行内/块级 LaTeX、实时预览和随机中文昵称。
- 同一来源 IP 默认 30 秒只能发布一次讨论；应用不保存或展示 IP。
- SQLite 保存元数据和讨论，视频文件保存在独立目录。

这是有意保持克制的 MVP。项目没有账号、推荐、审核、管理后台、删除、缩略图、转码、多段 Range 或分布式限流。进程重启会清空讨论限流状态，但视频、许可证和讨论仍会持久化。

## 技术要求

- Node.js 24 LTS
- npm（随 Node.js 提供）
- Docker Engine 与 Docker Compose 插件（仅容器部署需要）

应用只使用 Node.js 内置 `node:sqlite`，无需安装 SQLite 服务或编译原生数据库扩展。官方 Node 24 slim 镜像同时支持常见的 AMD64 和 ARM64 Linux 主机。

## 本机运行

```bash
git clone <你的仓库地址> nonprofit-video-mvp
cd nonprofit-video-mvp
cp .env.example .env
npm ci
node --env-file=.env src/index.js
```

打开 `http://127.0.0.1:3000`。应用启动时会创建数据库、视频目录和所需表结构。Node 的 `--env-file` 参数负责读取 `.env`；如果完全使用默认值，也可直接运行 `npm start`。所有配置都会在启动阶段校验，非法值会令进程立即退出并给出错误。

运行测试：

```bash
npm test
```

测试使用 Node.js 内置测试器，并覆盖许可证规范化、输入边界、Markdown/XSS、MP4 文件头、客户端 IP、冷却窗口、排序，以及真实 HTTP 上传、清理、Range 和讨论限流。

本次交付的桌面、390px 手机截图和真实视频/容器复验记录见 [`docs/qa/README.md`](docs/qa/README.md)。

## 配置

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口，必须是 1–65535 的整数。 |
| `HOST_BIND_ADDRESS` | `127.0.0.1` | 仅供 Compose 使用的宿主机发布地址；填写具体 LAN 地址可开启局域网访问。 |
| `DATABASE_PATH` | `./data/gongying.sqlite` | SQLite 数据库文件路径；父目录会自动创建。 |
| `VIDEO_STORAGE_PATH` | `./data/videos` | 已验证视频的永久存储目录；上传临时文件也放在同一文件系统，以便原子移动。 |
| `MAX_UPLOAD_MB` | `90` | 单个视频上传上限，单位 MiB，必须为正数。 |
| `DISCUSSION_COOLDOWN_SECONDS` | `30` | 同一来源 IP 两次讨论之间的最短秒数，必须为正整数。 |
| `CLIENT_IP_MODE` | `direct` | `direct` 或 `cloudflare`，决定限流所使用的客户端地址来源。 |

通过 `node --env-file=.env` 启动时，已有的进程环境变量优先于 `.env` 中的同名值；Compose 也会读取项目根目录的 `.env`。不要提交 `.env`、数据库或视频文件。

## Docker Compose（含 ARM64）

先复制配置并创建宿主数据目录。容器以非 root 的 `node` 用户（UID/GID 1000）运行，因此数据目录必须可由该用户写入：

```bash
cp .env.example .env
mkdir -p data/videos
docker compose build
docker compose up -d
docker compose ps
```

服务默认只发布在 `127.0.0.1:${PORT}`，不会直接监听宿主机的公网网卡。Compose 将 `./data` 挂载到 `/app/data`，数据库和视频不随容器重建而消失。如果主机上的 UID/GID 不是 1000，或出现 `EACCES`，请将 `data` 的所有者调整为容器用户：

```bash
sudo chown -R 1000:1000 data
```

查看日志或停止服务：

```bash
docker compose logs -f app
docker compose down
```

`docker compose down` 不会删除 `./data`。镜像基于多架构 `node:24-bookworm-slim`；在 ARM64 主机上直接执行上述构建即可。若需要在另一台机器显式构建 ARM64 镜像：

```bash
docker buildx build --platform linux/arm64 -t gongying-video-mvp:arm64 --load .
```

镜像与 Compose 都使用 `/healthz` 健康检查。服务健康后，该接口返回 HTTP 200。

## 局域网访问

先用 `ip -brief -4 address show scope global` 找到开发板的局域网 IPv4，然后在 `.env` 中把 `HOST_BIND_ADDRESS` 改成这个具体地址并重建容器：

```bash
sed -i 's/^HOST_BIND_ADDRESS=.*/HOST_BIND_ADDRESS=192.168.10.24/' .env
docker compose up -d --force-recreate
```

同一局域网的设备随后可打开 `http://192.168.10.24:3000`。优先绑定具体 LAN 地址，不要为了省事改成 `0.0.0.0`，否则服务也可能出现在 VPN、隧道或其他网卡上。如果主机启用了防火墙，只允许本地子网访问 TCP 3000；不要把该端口转发到公网。平台的上传和讨论均为公开匿名，局域网内任何能访问此地址的设备都可以发布内容。

## Cloudflare Tunnel

推荐让应用继续只监听宿主回环地址，再由同机的 Cloudflare Tunnel 访问它。使用 Tunnel 时请将 `HOST_BIND_ADDRESS` 恢复为 `127.0.0.1`，不要改成 `0.0.0.0`。

1. 在 Cloudflare Zero Trust 中建立 Tunnel 和 Public Hostname，将服务指向 `http://localhost:3000`。
2. 使用 token 运行同机的 `cloudflared`，或在其配置中加入下面的 ingress。
3. 确认公网域名可用后，将 `.env` 的 `CLIENT_IP_MODE` 改为 `cloudflare` 并重建容器。

```yaml
ingress:
  - hostname: video.example.org
    service: http://localhost:3000
  - service: http_status:404
```

```bash
sed -i 's/^CLIENT_IP_MODE=.*/CLIENT_IP_MODE=cloudflare/' .env
docker compose up -d --build
```

两种 IP 模式的信任边界：

- `direct` 只使用 TCP 连接地址，并忽略 `X-Forwarded-For`、`CF-Connecting-IP` 等代理头，适合直接访问或不需要还原访客 IP 的环境。
- `cloudflare` 只在 `CF-Connecting-IP` 是合法、单值 IP 时使用它；缺失或非法时安全回退到连接地址。这个请求头本身可由直接访问源站的客户端伪造，因此启用该模式时，必须让源站仅能经 Tunnel 到达。当前 Compose 的回环绑定正是这一安全边界的一部分。

若 `cloudflared` 运行在另一个容器，`localhost` 指向的是该容器自身。此时应将它加入同一 Compose 网络，并用 `http://app:3000` 访问应用，同时继续避免向公网发布应用端口。

Cloudflare Free/Pro 的单次 HTTP 请求体通常上限为 100 MB。默认 `MAX_UPLOAD_MB=90` 为 `multipart/form-data` 的字段和边界预留了空间；不要将应用上限误认为可绕过 Cloudflare 套餐限制。上传收到 Cloudflare 自己的 413 时，应缩小视频，或根据所用套餐和架构调整入口。

## 视频兼容性

平台仅接收并直接提供 MP4 文件。它会检查扩展名、MIME 类型和 MP4 的 `ftyp` 文件头，但不会探测内部编码，也不会转码或生成备用清晰度。

为了覆盖大多数现代手机和桌面浏览器，建议上传 H.264 视频加 AAC 音频的 MP4，并使用适合网络播放的 fast-start 布局。扩展名为 `.mp4` 且通过文件头检查，并不保证任意编码都能在浏览器中播放；播放兼容性由上传者负责。

## 备份与恢复

为获得一致备份，最简单的方式是短暂停止应用，然后复制整个 `data` 目录。这样会同时保留 SQLite 数据库、WAL 辅助文件（若存在）和所有视频：

```bash
docker compose stop app
tar -czf "gongying-backup-$(date +%Y%m%d-%H%M%S).tar.gz" data
docker compose start app
```

恢复到空目录时：

```bash
docker compose down
mv data data.before-restore
tar -xzf gongying-backup-YYYYMMDD-HHMMSS.tar.gz
sudo chown -R 1000:1000 data
docker compose up -d
```

恢复后打开 `/healthz`，再抽查视频播放、进度拖动、许可证和讨论。确认无误前保留 `data.before-restore`。不要只备份 SQLite 文件而遗漏视频目录，也不要在应用写入时随意复制单个数据库文件。

## 公网部署前须知

上传和讨论都是公开匿名的，这是 MVP 的既定边界，而不是完整的生产防滥用方案。部署到公网可能遭遇违法或侵权内容、垃圾讨论、超大流量以及持续上传导致的磁盘耗尽。至少应在入口层配置访问控制、请求速率和流量告警，并监控 `data` 所在磁盘；需要长期公开运营时，还应另行实现审核、删除、配额、备份保留和事件响应流程。

讨论限流是单进程内存表，只适用于当前单实例部署；多实例不会共享冷却状态。应用也不验证视频编码或扫描恶意内容。请依据所在地法律、内容政策和实际威胁模型再决定是否开放公网访问。

## 许可证行为

上传页默认勾选“署名”。如果取消署名，“非商业使用”和“禁止演绎”会同时清空并禁用，最终使用 CC0 1.0；后端会再次执行同样的规范化，不能靠伪造表单绕过。CC0 视频仍记录并展示必填的创作者名称，但使用者无需署名。其余勾选组合映射为对应的 CC 4.0 官方许可证，详情页会显示中文说明及官方 `rel="license"` 链接。

## 数据与隐私

SQLite 持久化视频标题、创作者、描述、许可证、文件元数据，以及讨论的随机昵称、Markdown 原文和时间。视频二进制文件单独保存。应用只在内存中短暂使用客户端 IP 做讨论冷却判断，不把 IP 写入数据库或页面。

讨论正文最多 5,000 个字符。页面响应包含限制脚本、媒体和表单来源的 Content Security Policy，以及防止 MIME 嗅探、页面嵌入和敏感来源泄露的基础安全响应头。
