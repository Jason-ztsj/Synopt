# Security Policy

## Status

This is a **reference / MVP implementation**, not a production-audited service. It is self-hosted experimental code. The media pipeline (upload, chunked reassembly, FFmpeg validation), authentication/session/CSRF model, and the CMS moderation system are intentionally substantive, but **this code has not undergone a professional security audit**, and FFmpeg isolation is container-level — **not a hardened sandbox**.

This is a **reference / MVP implementation** — you should review and harden it yourself before exposing it to the public internet (see “Before public deployment” in the README).

## Reporting a vulnerability

If you believe you have found a security issue, you can report it privately so it can be fixed before it’s discussed publicly. You’re welcome to use either:

- **GitHub private advisory** (Repository → Security → Report a vulnerability) — recommended, no email needed, keeps everything in one place; or
- **Email:** `jasonztsj@gmail.com` — if you don’t want to use an advisory.

Private reporting is appreciated so there’s time to address it. Please keep details confidential until it’s been handled.

Please include:

- A short description of the issue and its impact.
- Steps to reproduce (or a minimal PoC).
- Which component is affected (media pipeline / validator, auth & sessions, CSRF, CMS & governance, storage).
- Your contact if you want a follow-up.

Unlike a fast-moving project, **this is maintained sporadically by one student** — response may be slow. Please be patient; we will get to it. Do not expect a hardened, enterprise-grade disclosure process.

## Scope

In scope:

- Media upload, chunk assembly, and the FFmpeg validation worker.
- Authentication, sessions, CSRF, cookie handling.
- The CMS moderation / governance flow (report → case → claim → decision → appeal → audit).
- Data isolation, path handling, and storage.

Out of scope (or explicitly not guaranteed):

- Third-party libraries and the base images (report them upstream).
- Any deployment you modify beyond the provided Docker Compose config.
- The lack of email verification / reset / 2FA / quota / monitoring — these are documented gaps, not “bugs”.

Thank you for reporting responsibly.
