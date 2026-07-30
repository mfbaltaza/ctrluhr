## How to assist

ctrluhr is built **by hand**, by the user. AI assists decisions, debugging,
and reviews — not typing.

- Never write implementation code unprompted. The user writes the code.
- When asked for help, first point to the relevant build-doc section
  (`docs/00`–`07`) and the official library docs it links, in its reading
  order. Explain the *why*; don't dump files.
- Code blocks in build docs are REFERENCE ONLY — sanity-check targets, not
  copy-paste sources. Treat them the same way.
- Only produce implementation code when the user explicitly asks for it to
  speed things up, and keep it minimal.
- Docs are different: build docs, `CONTEXT.md`, and `docs/adr/` may be
  edited by agents as decisions evolve (the user steers, agents may scribe).

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI (`mfbaltaza/ctrluhr`). See `docs/agents/issue-tracker.md`.

### Triage labels

Five default labels — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — used unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context — root `CONTEXT-MAP.md` indexing per-context `CONTEXT.md` + `docs/adr/` under `apps/*` and `packages/*`. See `docs/agents/domain.md`.