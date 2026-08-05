# ctrluhr — Build Guide

A privacy-first RescueTime alternative built for personal habit construction.
You build it by hand, learning each tool as you go. AI participates — it can
join at any point to speed parts up — but the code is yours. These docs are
the interface between you and any working session: read top-to-bottom the
first time, then come back to each file as you reach that phase.

## The convention (read first — every doc, every session follows it)

These docs follow the convention recorded in **ADR-0007**. Any doc section
not yet in this format is legacy and is being rebuilt; the convention still
wins.

**Every step of every build doc is self-contained**, written in eight fields:

| Field | When | What it carries |
| --- | --- | --- |
| **Assumes** | always | What must already be true — checkable (files, commands), citing which earlier step produced it. Run the checks; if they pass, you may start here. |
| **Read first** | third-party steps | The official docs to read, in order, with the sections that matter for our use case. Reading is the work; the doc tells you where to focus. |
| **Do** | always | The work itself, with the *why*. Heavier on explanation for our own business logic, lighter where official docs can speak. |
| **Reference** | file-producing steps | The target shape of the file, marked REFERENCE ONLY — a sanity-check target, never a copy-paste source. If it and the official docs disagree, the docs win. |
| **Verify** | always | Copy-paste runnable commands with expected output. Must actually go red when the step failed. |
| **Pitfalls** | when real errors exist | Failures actually hit, with their actual messages — the project's scar tissue. Never hypothetical gotchas. |
| **Produces** | always | What exists when the step is done — becomes the Assumes of later steps. |
| **[commit]** | checkpoints | Commit. Small commits make rollbacks painless. |

The rules that make the format worth anything:

1. **Enter at any step.** Assumes/Produces chain the steps together. You (or
   an AI session) can start at any step whose Assumes checks pass — you never
   have to read a doc front-to-back to work on one part of it.
2. **Verify blocks are law.** They are runnable, they fail when the step
   failed, and every one of them has been executed at least once. An unrun
   verification is worse than none — that is how ADR-0006 happened. Never
   skip one; if you can't run it now, stop and say so.
3. **Official docs are the source of truth** for what a library's API looks
   like. Library versions change; the official docs are always more current
   than this repo. Each step links which docs to read and in what order.
4. **Code wins for built phases.** Where a doc and the repo disagree about
   something already built, the repo is truth and the doc is corrected — so a
   fresh builder following the doc lands exactly where the repo is. When the
   disagreement came from a real failure, the correction lands as a Pitfall
   with the error message. If the *code* is what you regret, that becomes a
   code-fix ticket, not a doc edit. Unbuilt phases are plan-first: verified
   against official docs and the ADRs.
5. **AI writes the guide; you follow it.** AI verifies docs against the repo
   and official docs, drafts the prose, and runs the Verify blocks. You steer
   through each doc's **adjudication list** — one line per doc/code
   disagreement with a recommendation (fix doc / code-fix ticket / pitfall) —
   because whether a deviation was intended is your call, not AI's.
   Everything else lands without prose review; following the guide is the
   review, and errors surface as build failures.
6. **Reference blocks are sanity-check targets.** If you're about to paste a
   code block from this repo into your editor, ask yourself "do I know why
   each line is here?" If not, re-read the linked docs and write it yourself.
   The friction is the learning.

**`07-future-phases.md` is a lean map, not a build doc.** Each unbuilt phase
gets a goal, entry criteria (a state check against the previous phase's
Produces), the ADRs that constrain it, and pointers to official docs. The
full build doc for a phase is written when that phase starts, from fresh
research — fast-moving libraries (TanStack Start pre-1.0, better-auth) are
documented at build time, not frozen early into prose that would stale.

Domain language and the decisions behind it live in `CONTEXT-MAP.md` →
`CONTEXT.md` and `docs/adr/` — use the glossary's terms when writing code,
issues, or new docs, and check the ADRs before re-litigating a decision.

## Philosophy

- **Habit construction, not billing** — the data serves you, not an invoice.
- **Local trust, cloud convenience** — full titles go to your own server; you
  own it.
- **AI as a later layer** — get the plumbing solid first, then add intelligence.
- **Learn by building** — every line of code is yours. AI assists decisions,
  debugging, and reviews — and authors these docs under your steering.

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

| Layer      | Choice                                               |
| ---------- | ---------------------------------------------------- |
| Daemon     | Go (stub in phase 0, real trackers in phase 1)       |
| API        | Hono on Bun + Drizzle ORM + better-auth (magic link) |
| DB         | Neon Postgres + pgvector                             |
| Web        | TanStack Start (React 19) + TanStack Query + ECharts |
| Monorepo   | Nx + pnpm workspaces + Go module                     |
| AI (later) | Vercel AI SDK + OpenAI/Anthropic                     |
| Email      | Resend (magic link delivery)                         |

## The docs

Each file is self-contained for its phase. Read them in order the first time:

| File                      | What it covers                                                                |
| ------------------------- | ----------------------------------------------------------------------------- |
| `00-plan-overview.md`     | Verified architecture reference: data flow, DB schema, phases, repo layout, risks. Start here. |
| `01-monorepo-setup.md`    | Nx + pnpm + Biome + Go module scaffolding.                                    |
| `02-database-setup.md`    | Neon project, pgvector, Drizzle schema + migrations.                          |
| `03-api-setup.md`         | Hono server, better-auth magic link, /devices, /events ingest, /analytics.    |
| `04-web-setup.md`         | TanStack Start, auth gate, dashboard with ECharts, /devices.                  |
| `05-daemon-setup.md`      | Go daemon: stub tracker, uplink client, tray, enrollment CLI.                 |
| `06-phase0-smoke-test.md` | Executable end-to-end exit gate. Run it when you think phase 0 is done.       |
| `07-future-phases.md`     | Lean map of phases 1–5: goals, entry criteria, constraining ADRs, doc pointers. |

## Rules of engagement for self-building

1. **Run a step's Assumes checks before starting it.** If they fail, you're
   in the wrong place — go to the step whose Produces is missing.
2. **Never skip a Verify block.** They exist because each one catches a whole
   class of bugs that get expensive later — and an unrun verification is how
   ADR-0006 happened.
3. **When reality deviates from the doc, say so.** Version bump, API change,
   different error — bring it to your working session so the doc gets
   corrected (code wins for built phases; real failures become pitfalls).
4. **Commit at every `[commit]` checkpoint.** Small commits make rollbacks
   painless.
5. **If you're stuck for more than 30 minutes on a single error, stop.**
   Re-read the step's Read first list, or come back to AI with the exact
   error + what you tried. Don't grind.

## External accounts you'll need

Create these before you start. None cost money for the MVP.

- **Neon** — https://neon.tech — serverless Postgres with pgvector. Free tier is enough.
- **Resend** — https://resend.com — transactional email for magic links. Free tier 3k/mo.
- **OpenAI** — https://platform.openai.com — for `text-embedding-3-small`. A $5 credit covers development.

You don't need Fly.io, Vercel, or Stripe accounts until phase 5. Everything runs locally until then.

## Phase you are currently on

Phase 0 — MVP plumbing. Committed: monorepo (01), database schema +
migrations (02), better-auth config with magic link (03 §0–3), web auth flow
with dashboard + devices routes (04). Next: Hono bootstrap + auth middlewares
+ routes (03 §4–8), then the daemon (05), then the 06 exit gate. Goal:
synthetic event from a stub daemon shows up on your React dashboard, behind
magic-link auth. Real tracking starts in phase 1 — gated on client-side
encryption (ADR-0002).

## Goal of phase 0 in one sentence

> You log into a React app via magic link, create a device, enroll a Go daemon
> with that device's token, and watch synthetic events appear on an ECharts
> timeline — all wired by you, no black boxes.

```bash
pnpm exec biome check .
```
