# 媒体接入与验证维护说明

这份文档描述同见当前实验版的媒体信任边界、状态机和故障恢复。设计目标是支持常见现代编码，并确保浏览器检测结果、文件名、MIME 和文件头都不能直接决定媒体是否公开。

## 兼容矩阵

浏览器输入容器：MP4/M4V、MOV、MKV、WebM。

规范资产：

| 视频轨 | 音频轨 | 规范容器 | 策略 |
| --- | --- | --- | --- |
| H.264/AVC | AAC 或无 | MP4 | 原生播放 |
| HEVC | AAC 或无 | MP4 | 实验性原生播放 |
| VP9 | Opus 或无 | WebM | 原生播放 |
| AV1 | Opus 或无 | WebM | 原生播放 |

只接受一条视频轨和至多一条音频轨。字幕、封面图、附件、数据轨、旧编码和矩阵外组合会被拒绝。浏览器的 Mediabunny Worker 通过 encoded packet source/sink 复制压缩码流；这里不调用 VideoEncoder、AudioEncoder 或 ffmpeg.wasm。

## 信任边界与状态机

```text
源文件
  │ 浏览器探测与可选纯 remux（不可信提示层）
  ▼
规范 MP4/WebM
  │ Multer 限额 + 扩展名/MIME/快速签名
  ▼
.tmp → 原子移动到 .pending → SQLite: pending
                                  │ 独立 validator 原子领取
                                  ▼
                              validating
                       ┌──────────┼──────────────┐
                       ▼          ▼              ▼
                     ready  ready_with_warnings rejected
                       │          │              │ 删除隔离文件
                       └────公开──┘

基础设施故障：validating → validation_failed → validator 重启后 pending
```

只有 `ready` 和 `ready_with_warnings` 会出现在首页、媒体路由和讨论接口。其他状态的详情只允许上传账号查看；匿名请求得到 404，媒体和讨论请求得到 409。

成功验证时，文件先从 `.pending` 原子移动到公开目录，再条件更新数据库。若进程在两步之间中断，记录仍不可公开；租期回收后验证器会从公开路径重新验证并完成状态更新。

## 服务端验证顺序

1. 检查文件是普通文件且大小合理。
2. ffprobe 使用 `file` 协议白名单遍历完整数据包，重新识别容器、轨道和编码。
3. 验证轨道数、兼容矩阵、时长、尺寸、像素数和帧率。
4. MP4 遍历全部顶层 box，要求 `ftyp`、`moov`、`mdat`，拒绝越界、截断和尾部未归属数据。
5. 对隔离文件计算服务端 SHA-256。
6. FFmpeg 分别把视频轨和音频轨完整解码到 null 输出，并确认进度覆盖媒体结尾。
7. 文件大小或修改时间在验证期间改变时，按系统故障处理，不发布结果。

结构越界、缺轨、未知编码、超限、空输出、未解码到结尾等条件零容忍。可恢复解码错误使用动态总量阈值：基础值为 `ceil(packetCount × MEDIA_DECODE_ERROR_RATE)`，短媒体至少容忍三个错误，同时把视频上限约束在一秒帧数、音频上限约束在约半秒 packet 数。FFmpeg 超过阈值时以失败码退出；阈值内但留下日志的作品标为 `ready_with_warnings`。

`rejected` 只用于能够归因于媒体内容的问题，并删除隔离文件。命令缺失、超时、进程被终止、资源不足或内部异常使用 `validation_failed`，保留文件以便重试。

## CMS 任务操作的边界

CMS 的任务页只是现有媒体管线和文件删除队列的受控入口，不是第二个 worker：

- 完整 `/cms/tasks` 与所有重试动作只限管理员。审核员的工作台可以显示 `validation_failed` 视频的必要内容摘要并跳到 CMS 视频页，但没有重试按钮；对删除队列只显示匿名失败总数，不暴露目标、存储文件名、错误或链接。
- 管理员只能把当前确为 `validation_failed` 的视频重置为 `pending`。CMS 不能写入 `ready`、`ready_with_warnings` 或伪造探测结果，后续仍由 validator 领取、探测和完整解码。
- 管理员只能把失败文件删除任务的 `next_attempt_at` 提前，使原队列消费者尽快重试。CMS 请求本身不调用 `unlink`，也不创建与现有目标重复的删除任务。
- 验证重试使用 SQL 的当前状态条件；删除重试还要比较页面携带的 `expectedUpdatedAt` 与任务 `updated_at`。状态更新与审计事件在同一事务提交。两个管理员同时重试不会产生两份任务，也不会覆盖 worker 已经完成或更新的结果。

这条边界保证技术状态、治理状态和物理文件生命周期继续由各自的单一事实来源维护。审核隐藏或移除视频只改变 `moderation_status`，媒体文件会保留以供申诉。

## 运行与观察

宿主机运行：

```bash
node --env-file=.env src/index.js
node --env-file=.env src/validator-worker.js
```

只清空当前队列后退出：

```bash
node --env-file=.env src/validator-worker.js --once
```

Compose 运行：

```bash
docker compose up -d
docker compose ps
docker compose logs -f app validator
```

`validator` 被配置为单实例、无网络、只读根文件系统、非 root、无 Linux capabilities，并设置 CPU、内存、PID 和文件描述符限制。不要随意扩容多个 validator；当前数据库领取是并发安全的，但租期恢复没有 worker 所有权令牌，多实例会扩大运维推理范围。

## 中断与残留恢复

- 常驻验证器会周期性回收超过 `MEDIA_VALIDATION_STALE_MINUTES` 的 `validating` 任务，而不是只在启动时检查。
- `validation_failed` 在验证器下次启动时重新排队。
- `.pending` 中没有数据库记录且超过十分钟的文件会被清理；`.tmp` 中超过一小时的 `.upload` 会被清理。
- 数据库仍跟踪的隔离文件、新近上传文件以及公开目录中的未知文件不会被自动删除。
- 备份必须同时停止 `app` 和 `validator`，并复制整个 `data` 目录，不能只复制 SQLite 主文件。
- 从 schema v4 升级带 CMS 的 schema v5 前也应按上述方式制作一致备份；程序不提供自动降级，回滚旧代码需要恢复升级前备份。

## 当前限制

- HEVC 只使用浏览器/系统原生能力；尚无 hevc.js、WebCodecs、DASH/HLS 或备用编码。
- `BufferTarget` 会让浏览器同时持有源文件和目标文件；当前 90 MiB 上限仍可能使低内存手机失败。
- 没有清晰度梯度、缩略图、响度规范化、转码、断点续传或分块上传。
- validator 的容器隔离降低风险，但不等于针对恶意编解码器输入的完备沙箱。
- schema v1 的历史作品迁移为 `ready` 与 `legacyUnverified`，不会在升级时自动重新验证或删除。

## 回归验证

```bash
npm run test:unit
npm run test:integration
docker compose config --quiet
```

集成测试需要本机存在 FFmpeg/ffprobe，并覆盖真实 H.264/AAC MP4、VP9/Opus WebM、正确 `ftyp` 后接垃圾、隔离区权限、动态 MIME、Range、讨论和进程重启。
