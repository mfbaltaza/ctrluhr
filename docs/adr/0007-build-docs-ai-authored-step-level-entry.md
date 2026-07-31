# Build docs are AI-authored with 8-field steps for step-level entry

The 2026-07 docs redo reframes `docs/README` + `docs/00`–`07` as the
**interface between the user and any working session**: a fresh session
(human or AI) must be able to enter at *any step* of any doc and be
productive. Decision: **every build-doc step is written in a fixed 8-field
format — Assumes / Read first / Do / Reference / Verify / Pitfalls /
Produces / [commit].** Assumes, Do, Verify, and Produces are mandatory on
every step; Read first is mandatory whenever a third-party library is
involved (the docs-as-source-of-truth convention, formalized); Reference
and Pitfalls appear only when the step produces a file or a real error was
hit. Assumes/Produces chain steps together — a step's Produces are the next
steps' Assumes — which is what makes step-level entry mechanical rather
than aspirational.

**Verify blocks must be copy-paste runnable and must actually go red when
the step failed.** ADR-0006's root cause was a verification step (03 §3.5
schema-sync) that existed but was skipped; an unrun verification is worse
than none. Consequently, "done" for any doc (or phase) requires every
Verify block to have been executed at least once, not merely written.

**When a build doc and the code disagree, code wins for built phases**
(01, 02, 04, and the built parts of 03): the repo is the truth of what was
built, and the doc is corrected so a fresh builder lands exactly where the
repo is. Drift that came from a real failure is preserved as a Pitfall
entry with the actual error message — the failure is where the learning
lives. The escape hatch: code the user regrets becomes a code-fix ticket,
not a doc edit. Unbuilt work is plan-first — verified against official docs
and ADRs, since there is no code to check against.

**Division of labor: AI writes the guide; the user follows it.** AI does
the verification (drift reports, link/command checks against official
docs), the scribing, and the execution of Verify blocks. The user steers
through one compact **adjudication list** per doc — each drift item one
line with a recommendation: fix doc / code-fix ticket / pitfall — because
"was this deviation intended?" is a judgment about intent that AI cannot
infer. Everything else lands without prose review; following the guide is
the review, and errors surface as build failures. This extends AGENTS.md's
"user steers, agents may scribe" for docs to full authorship for this
effort.

**`07-future-phases.md` becomes a lean map, not a build doc.** Each
unbuilt phase (1–5) gets a front-matter block — goal, entry criteria (a
state check against the previous phase's Produces), constraining ADRs, and
official-docs pointers. The full 8-field build doc for phase N is written
when phase N starts, fed by a fresh `/research` pass, so fast-moving
libraries (TanStack Start pre-1.0, better-auth) are documented at build
time rather than frozen early into prose that would stale.

## Considered options

- **Doc-level entry** (front-matter state check per doc, sequential steps):
  rejected — the user chose step-level entry as the honest unit of "join at
  any point," accepting the format discipline it costs.
- **Slim 4-field format** (Assumes / Do / Verify / Produces, everything
  else prose convention): rejected — Read first, Reference, and Pitfalls
  are exactly the fields that carry the docs-as-source-of-truth convention
  and the project's failure history.
- **Full 8-field detail for 07 now**: rejected — unverifiable content for
  phases that won't be built for months, in libraries that churn within
  weeks (better-auth changed under us inside phase 0).
- **User writes the prose, AI only verifies**: rejected — the user's
  learning comes from building with the guide, not from authoring it.

## Consequences

- Rewrite order is forced by the Assumes/Produces chain: `docs/README`
  (the convention contract) → `00` → `01`–`06` → `07`'s lean map.
- This pass pays the "corrected the next time each is touched" debt
  recorded in ADR-0006 (`uuid` → `text` ids in 00 §4, 02 §3, 03's
  snippets), plus columns the docs never mentioned (`habits.cadence`,
  `devices.api_token_hash`, `users.image`, `sessions.ip_address` /
  `user_agent`).
- The convention applies to every future build doc (phase 1+), not just
  this redo.
- One ticket per doc, cut via `/to-spec` → `/to-tickets`; worked in
  order, one context window per ticket.
