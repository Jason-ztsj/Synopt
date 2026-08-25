# Contributing

Thanks for taking an interest in *同见 (Tongjian)*. It is a small, self-hosted, non-profit video-sharing experiment, and it was itself built through deep AI collaboration (“vibe coding”). **Please read this first** so your effort isn’t wasted and you know exactly what to expect.

## Read this before anything

- **This is a hobby project maintained by one student.** There is **no SLA**. I will review things when I can — which may be slow or, occasionally, not at all. This is not a sign of disrespect for your work; it is simply my reality.
- **I absolutely encourage you to fork, use, learn from, and adapt this code** — that is the whole point of publishing it. If a PR here sits unmerged, please keep your fork. The ideas in this repo are free to take.
- **Security issues:** please report them **privately** (see [SECURITY.md](SECURITY.md)), never as a public issue or PoC.
- **License:** the project is [AGPL-3.0](LICENSE). By contributing, you agree that your contribution is licensed under AGPL-3.0. (This is the strongest “network copyleft” license — anyone who hosts a modified version must open-source it.)
- Many docs are in Chinese (the project’s working language). English PRs for docs/README/code comments are very welcome, but be aware the maintainer may be slower to review them.

## What kind of contributions are most useful

1. **Demonstrated bugs** with a minimal reproduction or a failing test.
2. **Tests** — especially for the validation state machine, the transparent ranking algorithm, governance/CMS CAS (compare-and-swap) paths, and moderation privacy boundaries.
3. **Small, focused fixes** that don’t add dependencies.
4. **Docs / translations** — the README is now bilingual; help keeping `README.md` (English) and `README.zh-CN.md` in sync is much appreciated.
5. **Ideas or design feedback**, even without code. The project cares about its design philosophy (transparent, recomputable ranking; “value” not “approval”; zero-transcode media; privacy-preserving moderation). A thoughtful issue or discussion is a real contribution.

Please **avoid** large sweeping refactors, new frameworks, or new runtime dependencies without first opening an issue to agree on the approach. The project deliberately favors simplicity (“KISS”).

## Setting up

```bash
git clone https://github.com/Jason-ztsj/Synopt.git synopt
cd synopt
cp .env.example .env
npm ci
```

### Running

```bash
# web app (terminal 1)
node --env-file=.env src/index.js

# media validator (terminal 2) — must run alongside the app
node --env-file=.env src/validator-worker.js
```

Open `http://127.0.0.1:3000`.

**Requires:** Node.js 24+ (for the built-in `node:sqlite`), and `ffmpeg`/`ffprobe` on the machine (the validator uses them; the web app uses ffmpeg to normalize small user images).

### Running tests

```bash
npm run test:unit          # fast, no external services
npm run test:integration   # boots real app + validator, needs ffmpeg
node scripts/validate-ranking.js   # offline ranking-invariant checks
```

Or run everything together with `npm test`.

## Conventions

- ES modules, Node.js only — no build step, no transpiler.
- Keep the single source of truth: the transparent ranking lives in `src/ranking.js` and is rendered verbatim on `/algorithm`; if you change the algorithm, change that file and the offline validator (`scripts/validate-ranking.js`), and keep `docs/algorithm.md` and the `/algorithm` page consistent.
- New config goes in `src/config.js` with a sensible default and an entry in `.env.example` and the README config table.
- Never commit `.env`, `data/`, `*.sqlite*`, video files, or backups.
- Prefer small, focused changes. Add or update tests with behavior changes.

## PR process

1. Fork the repo and open a branch.
2. Make a focused change with tests where it affects behavior.
3. Run the tests locally (`npm run test:unit`, and `npm run test:integration` if your change touches media/auth/CMS paths).
4. Open a PR with a clear description. CI runs the test suite automatically, but it is **not a guarantee** — the maintainer will review when time allows.
5. Expect slow, possibly no, response. Please don’t take it personally. Your fork is the safe home for your work.

## Grammar of good feedback

When reporting, please say **what you expected, what you actually saw, and how to reproduce**. For the ranking algorithm, note that “taste” (is the 3-tier value signal a good proxy?) needs real interaction data to calibrate — the mechanism is testable offline, the subjective judgment is not yet validated.
