# Multi-user from day one, self-hosted, SaaS deferred

The docs oscillate between "personal habit tool" (README) and a phase-5 SaaS
track (00/07). Decision: ctrluhr is **multi-user from the start** — many Users
on a single instance hosted and operated by the project's Operator. SaaS
hardening (billing, quotas, row-level security, encryption-at-rest with
user-held keys) is deferred to phase 5 and re-evaluated there.

## Consequences

- Per-user scoping of every row is a hard invariant from now on; the schema
  already enforces it (`user_id` on every table) and every future feature must
  preserve it.
- Full window titles stay plaintext on the Operator's server only until phase
  1 — superseded by ADR-0002, which pulls client-side encryption forward to
  gate real tracking and open signup.
- No billing, quota, or RLS work before phase 5.
- **Membership is open signup**: anyone who can reach the API may create an
  account via magic link. The cost/abuse exposure (strangers consuming Neon,
  Resend, and OpenAI budget) is accepted and revisited if it becomes a real
  problem; an allowlist can be added later without schema change.
