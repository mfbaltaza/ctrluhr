# ctrluhr — Build Guide

A privacy-first RescueTime alternative built for personal habit construction.
You are building this manually, learning each tool as you go. These docs are
your reference: read top-to-bottom the first time, then come back to each file
as you reach that phase.

## How these docs are written

These docs use a **docs-as-source-of-truth** convention for every step
that involves a third-party library, framework, or tool. The pattern:

- The official docs (better-auth, Hono, Drizzle, TanStack, etc.) are
  the source of truth for *what* the API looks like and *how* to call
  it. Library versions change; docs are always more current than this
  repo.
- Each step in a build doc links to **which** docs to read, **in what
  order**, and calls out the specific sections that matter for our use
  case. Reading is the work; the doc tells you where to focus.
- A "Reference — what the end file should look like" code block at the
  end of each step shows the *target shape* of the file. Use it to
  sanity-check what you've written — not as a source of truth to copy
  from. If the reference and the current docs disagree, the docs win.
- For our own business logic (enrollment flow, categorization rules,
  daemon config, etc.) the docs go heavier on code + explanations of
  the *why*, because there's no external doc to defer to.

**Rule of thumb:** if you're about to paste a code block from this repo
into your editor, ask yourself "do I know why each line is here?" If
not, re-read the linked docs and write it yourself. The friction is
the learning.

## Philosophy

- **Habit construction, not billing** — the data serves you, not an invoice.
- **Local trust, cloud convenience** — full titles go to your own server; you
  own it.
- **AI as a later layer** — get the plumbing solid first, then add intelligence.
- **Learn by building** — every line is yours. AI assists decisions, not typing.

## What you are building

A three-piece system that watches what you do on the computer, stores it, and
shows it back to you so you can build better habits:

```
  Go daemon ──HTTP──▶ Hono/Bun API ──SQL──▶ Neon Postgres
  (Windows+Linux)      (categorizes,            (pgvector)
   active window        persists, auth)
   tracker                                            ▲
                                                      │ HTTP
                                                      │
                        TanStack Start web app ──────┘
                        (React dashboard, ECharts)
```

## Stack (locked)

| Layer      | Choice                                              |
| ---------- | --------------------------------------------------- |
| Daemon     | Go (stub in phase 0, real trackers in phase 1)      |
| API        | Hono on Bun + Drizzle ORM + better-auth (magic link)|
| DB         | Neon Postgres + pgvector                            |
| Web        | TanStack Start (React 19) + TanStack Query + ECharts|
| Monorepo   | Nx + pnpm workspaces + Go module                    |
| AI (later) | Vercel AI SDK + OpenAI/Anthropic                    |
| Email      | Resend (magic link delivery)                        |

## How to use these docs

Each file is self-contained for its phase. Read them in order the first time:

| File                          | What it covers                                |
| ----------------------------- | --------------------------------------------- |
| `00-plan-overview.md`         | Full architecture, all phases, DB schema, data flow, decisions. Start here. |
| `01-monorepo-setup.md`        | Nx + pnpm + Biome + Go module scaffolding.    |
| `02-database-setup.md`        | Neon project, enable pgvector, Drizzle schema + migrations. |
| `03-api-setup.md`             | Hono server, better-auth magic link, /events ingest, /analytics. |
| `04-web-setup.md`             | TanStack Start, auth gate, dashboard with ECharts, /devices. |
| `05-daemon-setup.md`          | Go daemon: stub tracker, uplink client, tray, enrollment CLI. |
| `06-phase0-smoke-test.md`     | End-to-end verification checklist. Run this when you think phase 0 is done. |
| `07-future-phases.md`         | Phases 1–5 in detail. Read when you're ready to start the next phase. |

## Phase you are currently on

Phase 0 — MVP plumbing. Monorepo skeleton (Nx + pnpm + Biome + Go module) is in place; next: 02-database-setup. Goal: synthetic event from a stub daemon shows up on your React dashboard, behind magic-link auth. Real tracking starts in phase 1.

## Rules of engagement for self-building

1. **Read the whole file before starting that step.** Some files have ordering rules you'll miss if you skim.
2. **Keep notes.** When something deviates from the doc (version bump, API change), update the doc inline so your future self is grateful.
3. **Commit after every verifiable step.** Each doc marks `[commit]` checkpoints. Small commits make rollbacks painless.
4. **If you're stuck for more than 30 minutes on a single error, stop.** Re-read the surrounding doc section, or come back to AI with the exact error + what you tried. Don't grind.
5. **Don't skip the smoke tests.** They exist because each one catches a whole class of bugs that get expensive later.

## External accounts you'll need

Create these before you start. None cost money for the MVP.

- **Neon** — https://neon.tech — serverless Postgres with pgvector. Free tier is enough.
- **Resend** — https://resend.com — transactional email for magic links. Free tier 3k/mo.
- **OpenAI** — https://platform.openai.com — for `text-embedding-3-small`. martyr tier ($5 credit) covers development.

You don't need Fly.io, Vercel, or Stripe accounts until phase 5. Everything runs locally until then.

## Goal of phase 0 in one sentence

> You log into a React app via magic link, create a device, enroll a Go daemon
> with that device's token, and watch synthetic events appear on an ECharts
> timeline — all wired by you, no black boxes.

pnpm exec biome check .