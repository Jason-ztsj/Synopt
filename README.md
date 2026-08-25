# Tongjian (同见)

**English** · [中文版](README.zh-CN.md)

> **About “vibe coding”**
> This is a project built through deep collaboration with an AI, in the “vibe coding” style: most of the code was written by an AI, while the author set the direction, made the architecture and security decisions, and reviewed and verified each piece. This is a deliberate, modern engineering choice, and it is also an honest account of where this project came from — the repository contains a real, runnable implementation with full unit and integration tests, not a demo. An AI did a large share of the typing, while the positioning, trade-offs, and design judgments behind *Tongjian* have always been in human hands.
> If you are skeptical of quality because it was “AI-generated”: please run the tests and read the code to verify it yourself — an honest origin is not a reason to be dismissed.

*Tongjian* is an experimental MVP for open knowledge and non-profit video sharing: anyone can browse videos; after registering and signing in, you can upload MP4, MOV, MKV, or WebM, choose a Creative Commons license, and join discussions using Markdown, LaTeX, and a formula keyboard. The project prioritizes simplicity, self-hosting, and local resources — it does not depend on an external database or a runtime CDN.

The project’s name is 同见 (Tongjian). The English name is Synopt, which was chosen later — it was not the project’s original name. Because the project began before the English name existed, a few legacy identifiers remain in the code (e.g., `tongjian_session` / `tongjian_csrf` cookies and `tongjian:*` browser-storage keys) for continuity; they are internal and do not represent a branding preference. The database file is `synopt.sqlite`.

> This is a product and technical experiment, with no current plans for actual operation or a public service. CMS V1 provides a local reporting, moderation, appeal, and audit loop, but should not be understood as already having the full compliance, legal, security-operations, or incident-response capabilities of a production platform.

## Current features

- The home page is a directory for landscape long-form video, with top-bar search and category/tag filtering; it is currently ordered by upload time (descending), and browsing does not require sign-in.
- Username, display name, and password registration; the account menu offers public profile, my videos, my discussions, reports, appeals, notifications, settings, and sign-out, plus “admin console” for staff.
- Users can set a display name, a bio up to 500 characters, and a square avatar; avatars are actually decoded, stripped of original metadata, and normalized to WebP. Usernames are immutable, and each user has an author page showing only public videos.
- Only signed-in users can upload videos or start discussions; legacy MVP data is preserved as-is, and content from before migration may not be linked to an account.
- Upload supports title, creator credit, primary category, up to 8 tags, an optional description, a cover, and the media file; licenses: CC0 1.0, CC BY 4.0, CC BY-NC 4.0, CC BY-ND 4.0, CC BY-NC-ND 4.0.
- Custom covers accept strictly 16:9, 1280×720 to 3840×2160, up to 5 MiB JPEG/PNG/WebP; the server actually decodes, strips metadata, and stores as WebP. If none is uploaded, the validator generates a 1280×720 JPEG cover from the first frame.
- The browser reads the real container and tracks in a Web Worker, copying only the compressed bitstream and re-muxing when needed — never re-encoding. H.264/AAC and VP8/VP9/AV1 + Opus are normalized to the matching container; H.264 + MP3/Opus/FLAC and HEVC are limited compatibility; HEVC/AAC is normalized as experimental MP4.
- The server never trusts file names, MIME types, or browser-reported results. New media enters a non-public quarantine area and is validated by a separate process: ffprobe full-file probing, structure checks, SHA-256, and full FFmpeg decode. Only `ready` or `ready_with_warnings` appear on the home page, in the player, or in discussions.
- The native player supports `GET`, `HEAD`, and single-range HTTP Range, so playback and seeking work.
- Top-level discussions have titles and are collapsed by default; replies form a traceable tree with no logical depth limit (indentation is bounded). Bodies use safely-rendered Markdown, inline/block LaTeX, and live preview.
- Videos use a “value” rating with three tiers (受益匪浅 / 有所收获 / 收获不大 — “got a lot / some / little”); it reveals then votes. Discussions/replies keep “approve/disapprove” counts. One account has at most one removable, switchable choice per target.
- The catalogue (home / search / category / tag) is ordered by a public, recomputable “value heat” ranking; a “featured video” page is ordered by time-independent value. The rules, parameters, inputs, and data boundary are at `/algorithm` and [`docs/algorithm.md`](docs/algorithm.md).
- Authors can edit their own discussion titles and bodies; the page publicly shows the edit count and last-modified time. Deleting content that has replies leaves only an anonymous tombstone and never cascades to others’ replies.
- “My videos” supports reversible withdrawal and re-publishing; permanent deletion requires prior withdrawal and typing the full title. Governance evidence under review, with an open case/appeal, or still within the appeal window cannot be deleted by the author. When checks pass, file deletion is first persisted to a queue, then attempted immediately, with backoff retries on failure by the validator; only videos that were genuinely public, validated, and moderation-visible keep a read-only discussion archive at the original URL.
- In-app notifications cover replies, a “high value” endorsement of videos, and reserved system messages; unread votes are aggregated by work and by the net state of different accounts — cancel-and-re-vote does not inflate the count (low/medium value does not bother the author). The unread count refreshes every 30 seconds while the page is open.
- Signed-in members can report a video or discussion that does not belong to them and is currently visible, and track their own report progress in the account center; members affected by a video/discussion hide/remove or an account suspension can view the full governance decision involving them and file one appeal within the deadline. Report and decision pages keep up to 2,000 characters of full public explanation; system notifications only preview the first 1,000 Unicode characters; reporters do not see internal notes, staff identity, or sensitive evidence.
- A separate `/cms` workspace lets moderators and administrators handle cases, videos, and discussions. A case must be claimed first; only the current owner can add notes, moderate the target, authorize private media, or close it. An administrator can intervene/transfer but cannot skip claiming to perform these in-case actions. Administrators also manage account status and roles, categories/tags, failed tasks, and the full audit except for their own conflicts of interest. The backend reuses the account session and CSRF and requires re-entering the password for the current session.
- Moderation hide and removal do not pretend to be media corruption, and never directly delete the video file. Technical validation, author visibility/withdrawal, and platform governance state are independent; discussion moderation uses placeholders or tombstones to preserve the reply tree.
- The discussion editor integrates a local MathLive formula keyboard, which can insert inline/block formulas via templates and move the cursor structurally inside math inputs; the stored form is still portable Markdown/LaTeX text.
- Discussions are rate-limited by both account and source IP; registration and sign-in also have a brief source-IP cooldown. The app does not store or display IPs.
- SQLite stores accounts, sessions, notifications, video metadata, discussions, report cases, moderation actions, appeals, and audit; video, cover, and avatar files are stored in the data directory.

Current account/security boundaries:

- Passwords use Node.js `scrypt` with a random salt; plaintext is never stored.
- The browser only keeps a random session token; the database stores its SHA-256 digest. Sessions are valid for 168 hours by default.
- Write operations — registration, sign-in, sign-out, upload, starting discussions — all verify a CSRF token; the session and CSRF cookies use `HttpOnly`, `SameSite=Lax`, and should also enable `Secure` in HTTPS deployments.
- Currently there is no email verification, password reset, two-factor auth, user-facing session list, or storage quota. CMS V1 provides account suspension, staff-wide session revocation, content reporting and moderation, but does not offer setting an account `disabled`, bypassing media validation, or physically deleting a video immediately.
- A `suspended` account can still sign in with a valid password but can only browse public content, view its own reports and decisions, submit appeals, change its password, and sign out; upload, voting, discussions, profile changes, and CMS are all rejected server-side.
- Changing the password revokes sessions on other devices; account deletion is irreversible and can optionally permanently delete the user’s videos and delete their discussions under tombstone rules (unselected content is anonymized and kept). Deletion is also constrained by open cases, open appeals, and the appeal-window governance-evidence retention, and never cascades to clear them.
- Current LAN HTTP is not a secure context and only offers in-page notifications; browser system notifications during an open page require user authorization and HTTPS access. Web Push after closing the page is not yet implemented.
- Registration/sign-in, CMS password re-authentication, discussion, report, and image-processing cooldowns all live in single-process memory, clear on restart, and are not shared across instances. Registration and sign-in are keyed by source IP; CMS re-authentication counts both the staff account and the source IP; image normalization has an additional global concurrency cap and returns a retryable error at saturation.

## Technical requirements

- Node.js 24 LTS
- npm (bundled with Node.js)
- FFmpeg and ffprobe (when running directly on the host: the web app uses FFmpeg to normalize user images, and the validator uses both)
- Docker Engine and the Docker Compose plugin (only needed for container deployment)

The app uses Node.js’s built-in `node:sqlite`, so there is no need to install a SQLite service or compile a native database extension. MathLive and KaTeX are installed via npm and served locally; the browser never hits a CDN at runtime. It runs on common AMD64 and ARM64 Linux hosts, and has been verified to run on ARM development boards.

## Running locally

```bash
git clone https://github.com/Jason-ztsj/Synopt.git synopt
cd synopt
cp .env.example .env
npm ci
node --env-file=.env src/index.js
```

In another terminal, start the standalone validator:

```bash
cd synopt
node --env-file=.env src/validator-worker.js
```

Open `http://127.0.0.1:3000`. The app process listens on `0.0.0.0`, which is convenient for debugging over the LAN (e.g., on a machine without a display); localhost still works. On startup the app creates the data directory and runs backward-compatible database migrations, and never deletes existing videos or discussions.

Node’s `--env-file` flag reads `.env`; if you fully use defaults, you can also just run `npm start` and `npm run validator`. The web app and the validator must run together, otherwise new uploads safely stay in `pending` and are never accidentally published. All config is validated at startup; an invalid value immediately exits the process with an error.

## Enabling CMS and the first administrator

The CMS routes exist by default (no error-prone toggle); ordinary members have no backend permission. First create the target account through the public registration flow, then have an operator with access to the server and database explicitly grant the first administrator:

```bash
npm run admin:grant -- <username>
```

The command must run with the same `DATABASE_PATH` as the app; it does not create accounts and does not auto-promote any user from an environment variable. For a Compose deployment you can run it inside the running app container:

```bash
docker compose exec app npm run admin:grant -- <username>
```

The CLI goes through the same governance service: when actually granting a role it writes the moderation action, audit, and system notification under the `system-cli` identity, and re-running it on an already-admin account returns immediately. Later role changes happen in the CMS account page and are bounded by constraints such as “cannot self-demote” and “cannot demote, suspend, or delete the last active administrator.”

After signing in with a normal account, an administrator or moderator visits `/cms` and must re-enter the current password. Re-authentication only applies to the current session of the current staff member and is valid for 30 minutes by default; attempts are bounded by an `AUTH_COOLDOWN_SECONDS` cooldown keyed by both the staff account and the source IP. After a role is revoked or an account suspended, old cookies and unexpired re-authentication no longer confer backend access.

Staff members are also ordinary members, so the CMS always isolates conflicts of interest by governance target: content the staff member created, discussions carried by their videos, their own appeals, their own account, and videos/discussions they have reported cannot be read or processed by them; an administrator who reported one author’s content cannot enter or moderate that author’s account. This same boundary applies to cases, content, accounts, appeals, recent workbench actions, and the administrator audit; filters cannot bypass it. Discussion context keeps only the tree structure, and conflicting nodes mask body, author, status, and links. Private-media reads also re-check each time that the grantor has not reported the target. The underlying audit remains fully append-only; this viewing boundary avoids inferring a protected identity or evidence from internal operator fields.

Run the tests:

```bash
npm test
```

Or separately:

```bash
npm run test:unit
npm run test:integration
```

Tests cover config and input boundaries, passwords and security tokens, real avatar/cover decoding and metadata stripping, the image concurrency gate, database migrations, the persistent-deletion queue, license normalization, Markdown/XSS, client IP, cooldown windows, the media state machine and real FFmpeg validation, and real HTTP account/profile, content withdrawal/deletion, discussion tombstones, notifications, sign-out, MP4/WebM upload, fake-header rejection, Range, and discussion flows. CMS tests additionally cover the migrations, fixed permissions, re-authentication, target-level reporter isolation, report cases, content and account status CAS, appeals, audit, tag merging, validation ABA retries, and short-lived private-media authorization. Image and media tests call the host’s `ffmpeg`, and media tests also call `ffprobe`.

The screenshots and notes in [`docs/qa/README.md`](docs/qa/README.md) are a historical MVP baseline from before account features and are not a substitute for re-verifying the current version.

The media ingestion state machine, error classification, and interruption recovery are in [`docs/media-pipeline.md`](docs/media-pipeline.md).
Platform information architecture, landscape long-form video constraints, transparent ranking, and CMS data boundaries are in [`docs/platform-architecture.md`](docs/platform-architecture.md).
CMS permissions, state machines, transactions, and privacy boundaries are in [`docs/cms-technical-design.md`](docs/cms-technical-design.md); to first encounter the governance system, start at [`docs/cms-learning-guide.md`](docs/cms-learning-guide.md).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port; must be an integer 1–65535. |
| `HOST_BIND_ADDRESS` | `127.0.0.1` | Host publish address for Compose only; does not change the Node process’s listen address inside the container. |
| `DATABASE_PATH` | `./data/synopt.sqlite` | SQLite database path. |
| `VIDEO_STORAGE_PATH` | `./data/videos` | Directory for validated videos and same-filesystem upload temp files. |
| `MAX_UPLOAD_MB` | `1024` | Per-video upload cap, in MiB; must be positive. |
| `MEDIA_UPLOAD_CHUNK_MB` | `16` | Chunk size for chunked upload, in MiB. Larger files (client threshold ~50 MiB) auto-chunk; smaller files upload in a single request. |
| `MAX_VIDEO_DURATION_SECONDS` | `7200` | Longest media duration accepted by the server. |
| `MAX_VIDEO_WIDTH` / `MAX_VIDEO_HEIGHT` | `4096` | Per-side dimension limit. |
| `MAX_VIDEO_PIXELS` | `8847360` | Total pixel cap; default ~4096×2160. |
| `MAX_VIDEO_FPS` | `120` | Frame-rate cap. |
| `MEDIA_DECODE_ERROR_RATE` | `0.001` | Base error ratio allowed during full decode; there are also a minimum tolerance for short clips and an absolute error ceiling. |
| `MEDIA_VALIDATION_POLL_MS` | `1000` | Interval the validator polls pending tasks while idle. |
| `MEDIA_VALIDATION_STALE_MINUTES` | `30` | Liveness threshold for `validating` tasks; active workers renew the lease, and after a re-claim an old worker’s result is rejected by CAS. |
| `MEDIA_VALIDATION_THREADS` | `2` | Threads used by a single FFmpeg validation task. |
| `FFPROBE_PATH` / `FFMPEG_PATH` | `ffprobe` / `ffmpeg` | Commands or absolute paths on the host; the web app uses FFmpeg for image normalization, the validator uses both. |
| `IMAGE_NORMALIZATION_CONCURRENCY` | `2` | Global cap for the web process normalizing avatars/covers concurrently; max 8. |
| `IMAGE_NORMALIZATION_COOLDOWN_SECONDS` | `10` | Minimum seconds between two image normalizations for the same account or source IP. |
| `APP_CPUS` / `APP_MEMORY_LIMIT` / `APP_PIDS_LIMIT` | `2.0` / `1024m` / `96` | Resource caps for the Compose web service and its image-decode subprocesses. |
| `VALIDATOR_CPUS` | `2.0` | CPU cap for the Compose validator. |
| `VALIDATOR_MEMORY_LIMIT` | `1536m` | Memory/swap cap for the Compose validator. |
| `VALIDATOR_PIDS_LIMIT` | `64` | PID cap for the Compose validator. |
| `DISCUSSION_COOLDOWN_SECONDS` | `30` | Minimum seconds between two discussions for the same account or source IP. |
| `AUTH_COOLDOWN_SECONDS` | `2` | Cooldown seconds for registration/sign-in keyed by source IP; CMS password re-auth reuses it and counts both staff account and source IP. Max 3600. |
| `SESSION_TTL_HOURS` | `168` | Sign-in session lifetime; max 8760 hours. |
| `CMS_REAUTH_MINUTES` | `30` | Minutes a CMS password re-auth stays valid for the current session; max 1440. |
| `CMS_PRIVATE_MEDIA_GRANT_MINUTES` | `15` | Minutes a private-media grant bound to a backend session, case, and video stays valid; max 1440. |
| `REPORT_COOLDOWN_SECONDS` | `30` | Minimum seconds between consecutive reports for the same account or source IP; max 86400; state is in single-process memory. |
| `APPEAL_WINDOW_DAYS` | `30` | Days after an appealable action during which an affected member can appeal; max 3650. The same window also blocks authors from editing/deleting discussion evidence or deleting video evidence early. |
| `SESSION_COOKIE_SECURE` | `false` | Whether to add `Secure` to the session and CSRF cookies; set to `true` only over HTTPS. |
| `CLIENT_IP_MODE` | `direct` | `direct` or `cloudflare` — the source used for rate limiting. |

When started via `node --env-file=.env`, process environment variables take precedence over same-named values in `.env`; Compose also reads the `.env` in the project root. Do not commit `.env`, the database, or video files.

## Docker Compose

First copy the config and create the host data directory. Containers run as the non-root `node` user (UID/GID 1000), so the data directory must be writable by it:

```bash
cp .env.example .env
mkdir -p data/videos
docker compose build
docker compose up -d
docker compose ps
```

Compose starts two services, `app` and `validator`. Both images include FFmpeg: the web service uses it only to actually decode and normalize small user images; the standalone validator handles videos. Both use a read-only root filesystem, drop Linux capabilities, and cap CPU, memory, and PIDs; the validator also has networking fully disabled. They cooperate through the shared `./data` and SQLite state.

User images are currently still normalized synchronously inside the web request with a native decoder; a protocol allowlist, single-frame, timeout, per-process thread, per-account/IP cooldown, global concurrency gate, and container resource caps together bound this risk. For real operation you should move image normalization to a no-network, least-privilege worker like videos, and not treat the current MVP as the final isolation boundary.

By default the service is published only on `127.0.0.1:${PORT}`. Compose mounts `./data` to `/app/data`, so the database, accounts, and videos survive container recreation. If the host’s UID/GID is not 1000, or you hit `EACCES`, adjust the `data` owner to the container user:

```bash
sudo chown -R 1000:1000 data
```

View logs or stop the service:

```bash
docker compose logs -f app validator
docker compose down
```

`docker compose down` does not delete `./data`. The image is based on multi-arch `node:24-bookworm-slim`, so it builds directly on AMD64 or ARM64 hosts (and has been verified on ARM development boards). To explicitly build an ARM64 image on another machine:

```bash
docker buildx build --platform linux/arm64 -t synopt-video-mvp:arm64 --load .
```

Here `synopt-video-mvp` is just a local image tag, not a formal English product name. The `app` image and Compose service use a `/healthz` health check; the web service returns HTTP 200 when healthy, and the validator reflects status via exit code and logs.

## LAN / host debugging

When running Node directly, the app already listens on `0.0.0.0`. After starting on the machine, other devices on the same LAN can open `http://<host-lan-ip>:3000`.

With Compose, `HOST_BIND_ADDRESS` decides which addresses the host publishes the port on. You can find the machine’s address first:

```bash
ip -brief -4 address show scope global
```

Then choose one and write it into `.env` and rebuild the container:

```dotenv
# publish only to one explicit LAN address
HOST_BIND_ADDRESS=192.168.10.24

# or, for temporary headless debugging, publish to all interfaces
HOST_BIND_ADDRESS=0.0.0.0
```

```bash
docker compose up -d --force-recreate
```

`0.0.0.0` is an intentionally supported dev/debug config, but it also reaches VPN, tunnel, and other interfaces. Only use it on a trusted LAN, with a firewall limiting TCP 3000 to the local subnet, and never do public port forwarding. It is not a public production deployment.

## Cloudflare Tunnel (experimental only)

If you later trial HTTPS through Cloudflare Tunnel, it’s recommended to keep the host port bound to `127.0.0.1` and have a same-machine `cloudflared` connect to `http://localhost:3000`. After confirming the origin cannot be bypassed, set:

```dotenv
HOST_BIND_ADDRESS=127.0.0.1
CLIENT_IP_MODE=cloudflare
SESSION_COOKIE_SECURE=true
```

Trust boundaries of the two IP modes:

- `direct` uses only the TCP peer address and ignores proxy headers — suitable for direct LAN access.
- `cloudflare` reads a valid single-value `CF-Connecting-IP`, falling back to the peer address when missing/invalid. Direct accessors can forge this header, so in this mode the origin must be reachable only through a trusted Tunnel.

Tunnels and reverse proxies may impose their own request-body limits (Cloudflare often ~100 MB per request). The client auto-selects by a ~50 MiB threshold: larger normalized files use chunked upload (default 16 MiB per chunk, `MEDIA_UPLOAD_CHUNK_MB` adjustable), smaller files stay a single `multipart/form-data`. `MAX_UPLOAD_MB` already leaves room for multipart overhead; still verify the limits of the entry service and plan in use before experimenting.

## Video compatibility and validation

The browser can read MP4/M4V, MOV, MKV, and WebM input; the first release accepts exactly one video track and at most one audio track, and does not keep subtitles, attachments, or data tracks. The normalized asset matrix:

| Video | Audio | Server storage | Current playback |
| --- | --- | --- | --- |
| H.264 | AAC or no audio | MP4 | Native browser (guaranteed) |
| H.264 | MP3 / Opus / FLAC | MP4 | Native browser (limited — some browsers may fail) |
| VP8 | Opus or no audio | WebM | Native browser (guaranteed) |
| VP9 | Opus or no audio | WebM | Native browser (guaranteed) |
| AV1 | Opus or no audio | WebM | Native browser (guaranteed) |
| HEVC | AAC or no audio | MP4 | Experimental, depends on device HEVC |

Combinations that can be losslessly re-muxed into the target container but are not natively playable in every browser for standardization/ecosystem reasons (e.g., H.264 + MP3 audio, Opus/FLAC in MP4, HEVC) are flagged “limited compatibility”: the uploader sees a low-compatibility hint, and the player shows a notice. Combinations browsers clearly cannot play natively (e.g., MPEG-4 Part 2, AC-3, DTS, ALAC) are still rejected, with a transcode suggestion, rather than degraded-published.

Re-muxing only happens when the input container differs; compressed audio/video packets are copied verbatim, so speed is usually near file read/write and there is no quality loss. The first release explicitly does not use ffmpeg.wasm transcoding. Legacy codecs, incompatible audio/video combos, multi-track files, and rotation information that cannot be preserved reliably get processing advice before upload.

The browser check is only a UX layer. The server first checks the MP4/WebM signature of the normalized asset, then writes to `.pending`; the standalone validator re-confirms the real container and codecs, walks packets, checks duration/resolution/frame-rate and the MP4 top-level structure, computes SHA-256, and fully decodes video and audio separately. During long decode tasks the lease is renewed periodically; completion, rejection, failure, and automatic cover write must all match the latest lease version. After a task is re-claimed by another worker, the old worker can no longer submit state or queue a file deletion. Small recoverable error ratios get `ready_with_warnings`; exceeding a dynamic threshold, structural overruns, truncation, empty tracks, unknown codecs, or incomplete decode get `rejected`; infrastructure failures such as missing FFmpeg, timeout, or OOM are recorded as retryable `validation_failed`, never masked as “user file corrupted.”

There is currently no HEVC fallback via hevc.js/WebCodecs; such a fallback would need a separate segmented-media and HTTPS design. LAN HTTP does not affect this release’s pure demux/remux, but browsers without HEVC still cannot play HEVC. Within the current 1024 MiB test limit the browser holds both the source and the re-muxed result, so low-memory mobile devices may still fail; larger files will require a chunked, resumable upload design later.

## Backup, migration, and restore

The app runs forward migrations automatically at startup. The current schema is v7. The migrations added, in order: v5 keeps v4 data and adds governance versions, discussion moderation status, report cases, moderation actions, appeals, audit, and short-lived media grants; v6 rebuilds the videos table for media-compatibility tiers (widened codec checks and a `compatibility` column); v7 rebuilds `video_votes` into a three-tier “value” rating (高/中/低 — high/medium/low, `value IN (1,2,3)`). Old discussions default to `visible`, governance versions start at 0. The default database is named `synopt.sqlite`; don’t try to rebrand by hand-renaming and migrating only the database while forgetting the media files.

Before opening existing v4 data with a new version the first time, and before every later major upgrade, make a consistent backup. The most direct way is to briefly stop the app and validator and copy the whole `data` directory, which keeps the SQLite database, any WAL/SHM sidecar files, accounts, sessions, governance records, and all media together:

```bash
docker compose stop app validator
tar -czf "tongjian-backup-$(date +%Y%m%d-%H%M%S).tar.gz" data
docker compose start app validator
```

After upgrading, check `/healthz`, backend login, administrator count, pending cases, and the task queue, and confirm the database version and foreign keys. Running the project does not depend on the `sqlite3` command; if you installed that read-only tool separately, you can run:

```bash
sqlite3 data/synopt.sqlite 'PRAGMA user_version; PRAGMA foreign_key_check;'
```

The first result should be `7`, and `foreign_key_check` should return no rows. Don’t copy a single SQLite main file while the app is running, and don’t roll back by hand-lowering `PRAGMA user_version`; old programs cannot understand the v7 tables and states.

To restore into an empty directory:

```bash
docker compose down
mv data data.before-restore
tar -xzf tongjian-backup-YYYYMMDD-HHMMSS.tar.gz
sudo chown -R 1000:1000 data
docker compose up -d
```

After restoring, first check `/healthz`, then spot-check login, video playback and seeking, licenses, account ownership, discussions, staff roles, cases, and audit. Backed-up server-side session records and short-lived CMS grants may still be valid; the browser also needs the original session cookie. If you cannot confirm the trust boundary, treat sessions and backups as sensitive. Keep `data.before-restore` until you’ve confirmed the restore.

## Current-version acceptance checklist

After automated tests pass, at least manually verify:

1. Browsing and playback work unsigned-in; visiting `/upload` redirects to sign-in.
2. Registering immediately signs you in; the session survives a refresh, and case-sensitive duplicate usernames cannot register.
3. Signed-in users can choose MP4/MOV/MKV/WebM; the page shows the detected codecs and the “direct upload / lossless re-mux” plan.
4. After upload you first see the validation status; before validation the anonymous user cannot see details, and the media URL and discussion endpoints are unavailable; after passing, the page auto-shows the player and it enters the home feed.
5. H.264/AAC MP4 and VP9/Opus WebM play, seek, and return correct MIME; a fake header followed by garbage is rejected; without a cover, a first-frame cover is generated.
6. A custom cover must meet strict size, ratio, type, and header requirements; the home page and player keep a 16:9 landscape layout.
7. Top-level discussions have a title and are collapsed by default, with correct reply relationships; the formula keyboard inserts inline and block LaTeX, and structured input and live preview work.
8. A video’s three-tier “value” rating and discussions/replies’ approve/disapprove can both switch and cancel; the same account makes no duplicate vote.
9. Write requests with a missing or wrong CSRF token are rejected; discussion cooldown applies to both account and source IP.
10. The account menu is keyboard/Esc operable; profile, avatar, password, notification preferences, and the public author page render correctly.
11. After withdrawal, anonymous users can’t access the work via detail, media, or cover URLs; re-publishing restores access; permanent deletion requires prior withdrawal and keeps an anonymous discussion archive.
12. Discussion edit counts and times are correct; deleting a discussion with replies doesn’t delete sub-replies; notifications generate and aggregate by preference, and the sign-out option matches its confirmation page.
13. After signing out you can’t upload, vote, or start discussions; re-signing in with the correct password restores permission.
14. No page-level horizontal overflow at mobile and desktop widths; the sidebar becomes a drawer on mobile, and long formulas scroll only within the formula area.
15. After restarting both containers, accounts, avatars, notifications, covers, validated videos, category tags, votes, and discussions remain; an interrupted task recovers safely, and full media, `HEAD`, and single-range Range responses work.
16. Ordinary members can’t reach any `/cms` page; moderators and administrators must re-enter the password, and lose backend access immediately when the window expires or the role is revoked.
17. Members can’t report their own content or invisible targets; the same target can’t get duplicate open cases, consecutive reports are cooldown-limited, and the member’s own report page doesn’t show internal notes or staff identity.
18. When two staff members concurrently claim the same target, an old-version submission returns 409; unclaimed parties and a pre-transfer old owner can’t add notes, moderate the target, read authorized media, or close it. Notes also carry the case version and won’t cross a CAS with a transfer, closure, or another note; staff can’t open an active investigation, claim, or process a case on their own content; someone who reported the same target can’t process it via another case either. Video and discussion hide/remove/restore preserve technical validation, author withdrawal, and discussion-tree semantics, and a target must be restored to `visible` before a “no violation” closure.
19. An administrator can’t suspend or demote themself, nor suspend, demote, or delete the last active administrator via self-deletion; self-deletion proceeds only once another active administrator exists. A suspended account’s old sessions are revoked immediately; after re-sign-in it can only browse public content, view decisions, appeal, change password, and sign out.
20. Private/non-public videos show only a placeholder in the CMS list; an in-case grant carries the case `expectedVersion` and applies only to the current owner’s current session, an `in_review` case, and the target video; a transfer or closure deletes the old grant. After expiry, a case-version conflict, session/role invalidation, target mismatch, or the grantor having reported the target, the CMS-specific media route and Range can’t continue, and the cover stays a placeholder.
21. Each appealable hide/remove/suspension action accepts at most one appeal within the window; a `pending` appeal is first claimed by someone other than the original actor, and only the current reviewer can submit a result from `in_review`. The appellant, a reporter of the same target, and an administrator who reported the target author’s content cannot review; after a transfer only the new reviewer can continue. When a later governance action exists, a revocation doesn’t overwrite the new state but stays in `in_review`; the current reviewer must CAS on both appeal and target to choose restoring the original state or keeping the current later state. The author can’t delete the related video, or edit/delete related discussions, while a case/appeal is open or within the `APPEAL_WINDOW_DAYS` evidence retention window.
22. Task retries only reset a failed validation to `pending` or advance an existing deletion task; validation retries also compare the page-read validation start/finish twin timestamps, so an old page can’t overwrite a new failure after a “retry → fail again” ABA. CMS never writes `ready` or directly deletes a video file; moderators see an essential-content summary of a failed-validation video, and for the deletion queue only an anonymous failure count. `/cms/tasks`, full task detail, and retries are admin-only; every backend write goes to an append-only audit.
23. Staff can’t open their own content, their own appeals, their own account, or targets they’ve reported; an administrator who reported one author’s content can’t moderate that author’s account. Cases, content, accounts, appeals, the workbench, and audit uniformly isolate these targets, conflicting discussion nodes keep only the tree structure, filters cannot bypass it, and you can’t infer a reporter from internal events.

## Before public deployment

CMS V1 makes reports, cases, moderation decisions, account suspension, appeals, and audit form an accountable local loop, but it is still not enough to make the current MVP suitable for real operation. Public deployment can still face illegal/infringing content, spam accounts, password attacks, malicious files, traffic abuse, and disk exhaustion. There is also currently no email-ownership verification, password reset, account recovery, two-factor auth, storage quota, backup retention policy, professional legal process, monitoring/alerting, or incident-response system.

If you decide to operate in the future, build on CMS V1 with entry-layer rate limiting, TLS, monitoring/alerting, database and media backup retention, account recovery, staff training, and content policy and legal response processes. FFmpeg isolation should be upgraded further to a stricter sandbox. Do not expose this experimental code directly to the public internet.

## License behavior

The upload page defaults to checking “attribution”. When unchecking it, “non-commercial” and “no derivatives” are both cleared and disabled, and you end up with CC0 1.0; the backend re-normalizes, so you can’t bypass with a forged form. CC0 videos still record and show the required creator name, but users don’t need to attribute. Other combinations map to the corresponding CC 4.0 official licenses, and the detail page shows the Chinese description and the official `rel="license"` link.

## Data and privacy

SQLite persists username, display name, bio, avatar reference, salted password digest, session/CSRF token digests, notification preferences and unread messages, video metadata, validation status/summary/SHA-256, and discussions’ account association, display-name snapshot, Markdown source, and timestamps; video, cover, and avatar binaries are stored separately. Schema v5 also stores report and appeal reasons, public explanations, internal case notes, moderation actions, necessary pre/post governance snapshots, append-only audit, and private-media grants bound to session/case/video with an expiry. The audit does not store password hashes, cookies, CSRF, full media content, or unrelated personal data.

Browser-reported source containers and codecs are only diagnostic; the final values come from server probing. The app only briefly uses the client IP in memory for registration, sign-in, CMS password re-auth, discussion, and report cooldowns, never writing IPs to the database, audit, or pages; report and CMS re-auth cooldowns count both the signed-in account and the source IP. Reporter and staff identity, internal notes, and sensitive evidence never appear in public placeholders or member report results; the staff member themself, their own appeals, their own account, targets they’ve reported, and related author accounts are isolated from the corresponding CMS details, workbench, and audit views, and conflicting discussion nodes keep only the tree structure to avoid inferring a protected identity or evidence from internal fields. Backups contain full internal governance data and should be treated as sensitive.
