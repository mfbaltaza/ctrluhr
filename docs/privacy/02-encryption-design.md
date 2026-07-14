# Encryption Design

The cryptographic scheme that makes "we can't read your data" true. Read
this carefully. Getting crypto wrong voids the entire privacy story.

## Threat model

- **Server adversary**: your own cloud (API + DB) is compromised or
  subpoenaed. Attacker gets all ciphertext and metadata but no user keys.
  Goal: content is unintelligible, metadata is exposed.
- **Database breach at provider**: Neon is breached. Same as above —
  ciphertext + metadata, no keys.
- **Rogue employee**: an insider with DB access tries to read user
  content. Same protection.
- **MITM on the wire**: TLS already covers this; encryption is a
  defense-in-depth, not the primary TLS replacement.
- **Out of scope (E2EE does not help)**: attacker with access to the user's
  own device, malware on the user's machine, compromised browser session
  where the decrypted key is in memory.

## Key hierarchy

```
┌─ User passphrase (never sent to server, never persisted by daemon)
│   └─ Argon2id(passphrase, user_salt, ...) → master key (32 bytes)
│       ├─ encryption key  (XChaCha20-Poly1305, per-event nonces)
│       └─ wrapped key for sync between user's devices
│           (wrapped with a device-specific public key on enrollment)
│
└─ Per-event nonce: 24 random bytes (XChaCha20 nonce size).
```

### Master key derivation

The user picks a passphrase at signup (or passphrase+bio; we recommend a
passphrase because magic-link-only auth plus a local passphrase is a good
combination — the server never sees the passphrase, and the user does not
need to log in every time the daemon starts because the daemon can cache
the derived key in memory between runs, locked behind the OS session).

We use **Argon2id** via libsodium's `crypto_pwhash`:
- `opslimit = crypto_pwhash_OPSLIMIT_INTERACTIVE` (tuned to ~1s on consumer hardware)
- `memlimit = crypto_pwhash_MEMLIMIT_INTERACTIVE` (64–256MB)
- `salt = user_uuid` (server-generated, immutable, public — not secret, just unique per user)
- Output: 32 bytes = the master encryption key

Salt is the user UUID. Storing the salt is fine (it's not secret); its job
is to be unique per user so rainbow tables don't help.

### Key wrapping for multi-device

A user has multiple daemons. Each daemon derives the same master key from
the same passphrase + salt. That's the simplest sync model: every device
can decrypt all content.

If you want a stricter model later (per-device key, revoking a device
revokes its ability to read new content), you'll need a public-key wrapping
layer: each device generates an Ed25519/X25519 keypair on enrollment, the
master key is wrapped to each device's public key, server stores wrapped
keys. Revoking a device = deleting its wrapped key. **Phase 1 ships the
shared-passphrase model; phase 5 adds per-device wrapping.** Document this
in `09-risks-and-honesty.md`.

## Cipher choice: XChaCha20-Poly1305

Authenticated encryption with a 192-bit nonce. Long nonce means we can use
random nonces safely (no nonce-reuse risk in practice). Selected over
AES-GCM because:
- ChaCha20 is faster in software (no AES-NI needed — relevant for ARM
  devices and older CPUs).
- XChaCha20's extended nonce avoids the 96-bit GCM nonce-reuse footgun.
- libsodium has a stable high-level API: `crypto_aead_xchacha20poly1305_ietf`.

Use libsodium bindings:
- **Daemon (Go)**: `github.com/jamesruan/go-sodium` or `golang.org/x/crypto/nacl/secretbox` with `XChaCha20Poly1305` (need to use `golang.org/x/crypto/chacha20poly1305` with the XChaCha20 variant).
- **Web (TS)**: `libsodium-wrappers` npm package.
- Both use the same primitive, so keys and ciphertexts interop.

## What gets encrypted (plaintext → ciphertext)

| Field                      | Encrypted? | Why                                |
| -------------------------- | ---------- | ---------------------------------- |
| `activity_events.window_title` | YES    | The crown jewel. Reveals browsing, docs, emails. |
| `activity_events.app_name`     | YES    | App identity itself is personal data ("Signal", "Tinder"). |
| `activity_events.category_id` | NO (stays plaintext) | Needed for SQL grouping/aggregation; user assigned a category to it explicitly. |
| `activity_events.productive`   | NO plaintext int  | Same — user's classification. |
| `activity_events.started_at`, `ended_at` | NO | Needed for time-based queries. Metadata trade-off documented. |
| `activity_events.raw_embedding` | REMOVED from schema | Server can't compute or use an embedding it can't read. Local embedding in daemon instead. See `06-ai-flow-redesign.md`. |
| `categories.name`           | YES (encrypted at rest) | "AA sponsor" or "quit drinking" are sensitive. UI decrypts client-side. |
| `categories.color`          | NO        | Not sensitive. |
| `categories.is_productive`  | NO        | Needed for SQL. |
| `categories.embedding`      | REMOVED | Can't be a server-side centroid if server can't read titles. |
| `category_rules.pattern`    | YES      | The regex pattern itself can leak ("1password.com", "reddit.com/r/anxiety"). Encrypted; matched client-side only. |
| `category_rules.pattern_type` | NO      | Not sensitive. |
| `habits.name`               | YES      | As sensitive as category names. |
| `habits.linked_category_id` | NO      | FK stays plaintext for SQL joins. |
| `habits.target_minutes_per_day` | NO  | Not sensitive. |
| `devices.name`              | NO        | Useful to display server-side ("my-laptop"); user's judgement call. |
| `users.email`               | NO        | Needed for magic link auth. Account data. |

### TL;DR of the map

**Encrypted at rest, decrypted only in client**: `window_title`,
`app_name`, `categories.name`, `category_rules.pattern`, `habits.name`.

**Removed from schema entirely**: `raw_embedding`, `categories.embedding`.
Embeddings are a server-side technique that requires plaintext. Move them
out — see `06-ai-flow-redesign.md`.

**Plaintext (server-readable)**: everything else — IDs, timestamps,
FKs, productivity flag, category color, habit target. These are metadata
you must document in `08-privacy-policy-skeleton.md` as personal data you
process.

## Nonce management

For XChaCha20-Poly1305 with a 24-byte nonce, **use a fresh random nonce
per encryption operation.** The probability of collision is negligible
(Birthday bound ~2^96). libsodium's `randombytes_buf` gives you this.

Store the nonce in the same row as the ciphertext (prepend or use a
separate column). Nonces are not secret.

```sql
activity_events (
  -- renamed from window_title (text) to:
  window_title_ct  bytea not null,
  window_title_nonce  bytea not null,
  app_name_ct      bytea not null,
  app_name_nonce   bytea not null,
  ...
)
```

Column names reflect what they hold. Drizzle schema correction in
`03-schema-corrections.md`.

## Wire format (client → API)

The daemon encrypts locally before POSTing. The API never receives
plaintext content for `window_title`, `app_name`, `category.name`, etc.
The wire payload is:

```json
{
  "events": [
    {
      "id": "uuid",
      "app_name_ct": "base64(XChaCha20Poly1305(...))",
      "app_name_nonce": "base64(24 bytes)",
      "window_title_ct": "base64(...)",
      "window_title_nonce": "base64(24 bytes)",
      "category_id": "uuid|null",
      "started_at": "2025-07-10T10:00:00Z",
      "ended_at": "2025-07-10T10:05:00Z"
    }
  ]
}
```

The Zod schema in `packages/schema` needs to reflect this new shape.
Correction noted in `03-schema-corrections.md`.

## Key custody

- **Daemon**: derives the master key from the user's passphrase at signup
  and caches it in process memory for the session. On a headless server
  deployment (no user to type a passphrase) you'd store the key in a
  locked file with 0600 permissions — but that's phase 5 territory. For
  phase 0/1 the daemon runs under your user account, derives the key on
  start, prompts for passphrase if not cached for the session.
- **Web**: the user's passphrase unlocks key material in memory for the
  browser session. Stored in the page's JS heap only; cleared on logout or
  tab close. NOT in localStorage (XSS would steal it).
- **Server**: never has the key. Cannot bootstrap decryption. This is the
  invariant you must preserve at all costs.

## What E2EE does not protect

- **Timing metadata**: `started_at` and `ended_at` are still plaintext
  because analytics queries need them. An attacker watching the DB knows
  the user was "doing something" from 9:00 to 11:14 on Tuesday, even if
  they don't know what. This is a significant leak. Document it.

- **Category bucket metadata**: `category_id` is plaintext. An attacker
  learns the user has category `uuid_A` with `is_productive=-1` (distracting)
  and spent 4 hours in it on Monday. Category *name* is encrypted, but
  correlation across rows reveals structure.

- **Volume/frequency**: how many events per hour. Reveals your work
  pattern.

- **Device name**: "Home-iMac" stays plaintext.

- **What happens in the browser after decryption**: an XSS in your web
  app reads decrypted plaintext from React state. E2EE does not protect
  against a compromised script in the trusted page.

The privacy policy must disclose all of the above as "metadata we
process".

## Cipher library versions to pin

Daemon (Go):
```go
import "golang.org/x/crypto/chacha20poly1305"
// Use chacha20poly1305.NewX() for XChaCha20-Poly1305 (IETF-style, 192-bit nonce).
```

Web (TS):
```json
"dependencies": { "libsodium-wrappers": "^0.7.15" }
```

Both produce/consume the same wire format: 24-byte nonce prefix + ciphertext
+ 16-byte Poly1305 tag.

## Test vectors for interop

Before you ship, verify that a key + nonce + plaintext encrypted on the Go
daemon decrypts correctly in the TS browser. Write a unit test pair:

1. Go encrypts "Visual Studio Code" with key K, nonce N → produces bytes C.
2. TS bases decodes C and decrypts with key K, nonce N → produces "Visual Studio Code".

If this fails, the two libraries are using different variants of ChaCha20
(most likely the IETF vs original nonce size). Pin to the XChaCha20
variant both sides. This is a one-day integration task; do it before
writing the upload path.