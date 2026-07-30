# Client-side encryption gates phase 1 (titles + app names)

Docs 00–07 assume full window titles stored plaintext on the server, with an
encryption decision deferred to phase 5. Open signup (ADR-0001) breaks that
assumption: strangers' titles would sit in the Operator's database from their
first day. Decision: **before real tracking ships and before open signup
opens, the daemon encrypts `app_name` and `window_title` client-side**; the
server stores only ciphertext for content fields. Timestamps, `category_id`,
and `productive` stay plaintext so SQL analytics keep working. The server
never holds user keys, so already-stored plaintext can never be
retro-encrypted — which is why this is a hard gate, not a gradual rollout.

## Consequences

- Phase 2's server-side embedding categorization (OpenAI + pgvector centroids)
  and phase 4's server-side AI cannot work as written in docs 00/07.
  Categorization becomes: rules executed **in the daemon** (plaintext is local
  there), plus **browser-mediated intelligence** (the web app decrypts the
  uncategorized queue in-session and categorizes it there). Relabeling and
  retroactive reclassification stay cheap: they only touch `category_id`,
  which is plaintext.
- `raw_embedding` and `categories.embedding` lose their server-side role;
  pgvector's future is re-evaluated when phase 2 is designed.
- Browser-mediated categorization has two explicit consent tiers: **BYOK**
  (default) — the browser calls OpenAI directly with the user's own key; and
  **proxied** (opt-in, labeled in the UI as less private) — the browser sends
  decrypted titles to the API, which calls OpenAI with the Operator's key and
  returns embeddings. The proxy tier must be transient: content is never
  persisted or logged server-side, only seen in-flight per request. Manual
  relabel remains the always-available floor.
- Phase 0 completes as designed (synthetic fixtures, Operator-only): nothing
  sensitive exists before the gate.
