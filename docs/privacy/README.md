# Privacy & Legal — README

This subfolder **supersedes** parts of the top-level docs (`00`–`07`).
Whenever a design decision here conflicts with something in `docs/00`–`07`,
**this folder wins**. The older files are left intact because they describe
the simpler architecture; the corrections live here so the diff is explicit
and you learn what changed and why.

## Files

| File                          | What it covers                                   |
| ----------------------------- | ------------------------------------------------ |
| `01-legal-framework.md`        | GDPR/CCPA posture with E2EE. What you still owe. |
| `02-encryption-design.md`     | Key derivation, cipher, per-field encryption, what stays plaintext. |
| `03-schema-corrections.md`   | What changes in the Drizzle schema from `docs/02`. |
| `04-api-corrections.md`       | What changes in routes/categorizer from `docs/03`. |
| `05-daemon-corrections.md`    | What changes in the Go daemon from `docs/05`. |
| `06-ai-flow-redesign.md`      | How AI features survive E2EE (client-mediated, ephemeral). |
| `07-subprocessors.md`         | The shorter subprocessor list, and what each sees. |
| `08-privacy-policy-skeleton.md`| A skeleton you can hand to a lawyer. |
| `09-risks-and-honesty.md`     | Key recovery, law enforcement, metadata leaks, what E2EE does NOT solve. |

## TL;DR of the whole folder

1. **Client-side encryption (E2EE) is now a core design pillar, not a
   phase-5 add-on.** The daemon holds a user key; titles are encrypted
   before they leave the machine; the server stores ciphertext.
2. **You remain a data controller** for account metadata (email, billing,
   timestamps, device IDs). E2EE does not exempt you from GDPR/CCPA — it
   shrinks what you control.
3. **OpenAI/Anthropic drop out of your subprocessor list for content.**
   Embeddings-based categorization moves either to a local model in the
   daemon, or to an ephemeral client-mediated flow during AI features.
4. **AI features are restructured**: server-side AI over plaintext is
   removed; AI runs against decrypted data in the browser, with the user's
   key, and the server is never an intermediary that can read content.
5. **What you can truthfully tell users**: "We cannot read your activity
   data. A breach of our database exposes ciphertext, not your window
   titles." This is the selling point.
6. **What you still must build**: privacy policy, DPA with subprocessors,
   access/export/delete endpoints, retention policy, breach procedure.
7. **What E2EE does not solve**: metadata (timing, volume, device), lost
   key recovery, law enforcement orders on metadata, the fact that
   `category_id` and `habit` names are still plaintext in the current
   schema unless you also encrypt those.

## Reading order

Read `01-legal-framework.md` first to understand the legal shape. Then
`02-encryption-design.md` for the cryptographic design. Then the
correction files in order (`03` → `05`) to see what changes in the build.
Finally `06-ai-flow-redesign.md` for the AI complication, and
`08-privacy-policy-skeleton.md` for the policy text. `09-risks-and-honesty.md`
is the file to re-read when you're tempted to over-claim.