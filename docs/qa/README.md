# 同见 MVP 历史基线验收记录

> 以下内容记录的是 2026-08-19 的旧版 MVP 验收。当时产品仍使用“共映”界面、匿名上传和随机讨论昵称，截图也保留了该历史状态。当前“同见”版本已加入账号、会话、CSRF 保护和本地 MathLive 公式键盘；测试数量与交互边界均已变化，应以根目录 README 的当前验收清单和最新测试结果为准。

验收日期：2026-08-19（Asia/Shanghai）

## 自动化与运行环境

- 完整测试：22/22 通过，使用 Node.js 内置测试器。
- 目标运行时复验：`node:24-bookworm-slim`，Node.js v24.19.0，Linux ARM64。
- 生产依赖审计：0 个已知漏洞。
- Compose：容器以 `node` 非 root 用户运行，健康检查通过，端口仅绑定 `127.0.0.1:3000`。

## 真实视频与 HTTP

ffmpeg 生成了 60 秒、54,142,037 字节的真实 MP4，视频为 H.264、音频为 AAC，并启用 fast-start。它通过原生浏览器上传表单成功发布，详情页显示精确的 `CC BY-NC-ND 4.0`、创作者名称及官方许可链接。

关键响应：

- 成功上传：303
- 完整媒体与 HEAD：200
- 单段及后缀 Range：206
- 不可满足或多段 Range：416
- 错误扩展名、MIME、`ftyp`：400，临时文件清理完成
- 超限文件：413，临时文件和数据库残留均为零
- 首次讨论：201（JSON）或 303（普通表单）
- 立即重复讨论：429，`Retry-After: 30`

应用进程与 Compose 容器分别重启后，视频、许可证、Range 和两条讨论均仍存在；讨论冷却按设计在进程重启后清空。

## Chromium 桌面与手机验收

真实 Chromium 完成了以下 DOM 与交互断言：

- 1440×1000：主页、详情、播放器、许可证、讨论编辑器均无页面级横向溢出。
- 390×844：详情、上传和编辑器均无页面级横向溢出；编辑与预览上下排列。
- 许可证默认是 CC BY；取消署名会立即清空并禁用 NC/ND，显示 CC0；重新选择 BY+NC+ND 显示精确官方链接。
- 浏览器实际选择并上传 52 MiB 文件，随后进入详情页。
- Markdown 粗体、链接、列表和 KaTeX 预览成功；用户链接带 `ugc nofollow noopener`。
- 长块级公式只在公式容器内横向滚动，不撑宽手机页面。
- 浏览器发布讨论后页面刷新可见；立即重复时按钮禁用并显示中文秒数倒计时。

当前系统自带的无头 Chromium 不包含 MP4/H.264 解码器（`canPlayType` 返回空），因此它不能在此环境内解码画面；这不是媒体路由或文件格式错误。同一 Chromium 对播放器 `currentSrc` 发起 Range 请求得到 `206`、精确 `Content-Range` 和 `ftyp`，ffprobe 也确认文件为 60 秒 H.264/AAC。应在带系统媒体解码器的目标手机/桌面浏览器上做最终肉眼播放抽查。

## 截图

- [桌面主页](desktop-home.png)
- [桌面详情与播放器](desktop-detail.png)
- [桌面讨论与实时预览](desktop-discussion-preview-final.png)
- [手机详情](mobile-detail.png)
- [手机长公式滚动](mobile-editor-long-formula-final.png)
- [手机许可证选择](mobile-upload-license-final.png)
