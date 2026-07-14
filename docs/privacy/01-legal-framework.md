# Legal Framework (with E2EE)

This is a practical map, not legal advice. You are building a SaaS that
processes potentially sensitive personal data. With client-side encryption
the legal posture improves significantly but does not vanish. Use this to
talk to a lawyer, not in place of one.

## Roles under GDPR

You are simultaneously:

- **Data controller** for account data: email, billing, login timestamps,
  device IDs, IP at signup, any metadata you persist.
- **Processor** for the ciphertext content rows you store (you store them
  but cannot read them; this is a narrow and favourable position).
- **Controller** for metadata about activity (timing, volume, device
  association) unless you also encrypt or minimize that away.

E2EE moves the *content* of activity events out of the controller bucket
and into "inaccessible storage". That's a real shift, but the controller
bucket above is non-trivial and you must comply with it regardless.

## What you still owe under GDPR (even with E2EE)

| Obligation                              | Applies to                          | How you satisfy it                              |
| --------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| Lawful basis for processing             | Account + metadata                  | Consent at signup; contract for billing         |
| Privacy policy + cookie policy          | All users                           | See `08-privacy-policy-skeleton.md`             |
| Data Processing Agreement w/ subprocessors | Every subprocessor              | See `07-subprocessors.md` (the shortened list) |
| Access right (art. 15)                  | Account + metadata                  | `GET /me/export` returns everything in plaintext you have; for ciphertext, user decrypts client-side |
| Rectification (art. 16)                 | Account                             | `PATCH /me` for email, etc.                     |
| Erasure (art. 17)                        | Account + metadata + ciphertext     | `DELETE /me` cascades all rows; documented PITR window in `08` |
| Portability (art. 20)                   | Account + ciphertext                | `GET /me/export?format=json` includes ciphertext for client decryption |
| Consent management                       | Non-essential processing            | Settings page: toggle analytics, toggle marketing |
| Breach notification (72h)                | Account/metadata breach             | Runbook + contact list; see `09`               |
| Records of processing (art. 30)         | All processing activities           | A `processing-register.md` you maintain in this folder |
| International transfers (Schrems II)    | Any subprocessor outside EU         | SCCs + TIA per subprocessor; see `07`          |
| DPIA (art. 35)                          | High-risk processing                | Required because activity tracking is inherently high-risk; E2EE reduces residual risk but does not eliminate the DPIA duty |

## What E2EE removes or shrinks

- **OpenAI/Anthropic as content subprocessors** — moot. You never send
  plaintext to them. See `06-ai-flow-redesign.md`.
- **Breach severity for content** — a DB breach exposing ciphertext rows is
  *not* a content-level breach under GDPR art. 34 (notification to data
  subjects) because the content is unintelligible to you or to the attacker
  without user keys. You *do* still have a metadata breach to notify on
  (emails, timestamps).
- **Rectification of content** — users do it client-side; server only
  stores new ciphertext. You cannot be asked to correct what you can't read.
- **Subpoena compliance for content** — you can truthfully answer "we do
  not have the ability to decrypt this data". You still must comply for
  metadata.
- **Schrems II for title content** — no title content leaves the EU user's
  device in plaintext; the ciphertext that flows to Neon (if EU region) is
  not personal data in the GDPR sense (it's encrypted random bytes).

## CCPA (California)

CPRA/CCPA applies if you serve CA residents and cross the thresholds
(revenue or processing volume). The good news: with E2EE the "sensitive
personal information" bucket shrinks to account+metadata only, and the
"right to know what personal information we sell or share" has a clean
answer: nothing content-level is sold or shared.

You still must provide:
- "Do Not Sell or Share My Personal Information" link (even if you sell
  nothing — the form is required).
- Privacy policy at collection time.
- Right to delete, right to correct, right to limit use of sensitive PI.

## What you must do at launch (legal checklist)

- [ ] Privacy policy live (`08` skeleton).
- [ ] Terms of Service.
- [ ] DPA template ready (for B2B / EU users who ask).
- [ ] SCCs in place with every non-EU subprocessor (`07`).
- [ ] Cookie banner (only if you use non-essential cookies; better-auth uses
  a session cookie which is strictly necessary — so you may not need a
  banner at all, but it depends on whether you add analytics).
- [ ] Data retention policy documented (default 90 days for free tier? all
  data for paid? — your call, document it).
- [ ] Records of processing (article 30 register) in an internal doc.
- [ ] Breach response runbook.
- [ ] Contact email for privacy concerns published.
- [ ] `GET /me/export` and `DELETE /me` endpoints.
- [ ] Signup flow obtains explicit consent for: account processing,
  analytics (default off), marketing (default off).

## What you must do before serving EU users specifically

- Confirm at least one EU region option for EACH subprocessor (Neon: yes;
  Resend: limited — confirm; hosting: Fly.io has EU regions).
- SCCs filed for non-EU subprocessors.
- Transfer Impact Assessment (TIA) per subprocessor.
- Localize privacy policy in EU official languages if targeting.
- Appoint an EU representative if you have no EU presence and process EU
  data at scale (rarely needed at launch; revisit at phase 5).

## How to talk about it publicly (marketing posture)

Do say:
- "We cannot read your activity data. Your window titles are encrypted on
  your device before they reach us."
- "A database breach exposes ciphertext, not your browsing history."
- "We do not share your activity data with advertising or analytics
  companies."

Do not say:
- "We are GDPR-exempt because of E2EE." (False. Account data is still
  regulated.)
- "We are end-to-end encrypted like Signal." (Mostly true but Signal is a
  messenger; the analogy oversimplifies — you still store the ciphertext,
  Signal doesn't store messages at all. Use "client-side encrypted" or
  "zero-knowledge storage" instead.)
- "Your data is anonymous." (Timestamps + device ID + ciphertext is not
  anonymous. Pseudonymous at best.)

## When to call a lawyer

Before you:
- Serve the first EU or CA user.
- Announce pricing (becomes contract + consumer law).
- Add any processor that touches plaintext (e.g. an analytics tool on the
  web app).
- Write a press release that uses the words "anonymous", "private",
  "secure", "zero-knowledge", "end-to-end". Get the claims reviewed.

A privacy-specialist lawyer for a 2-hour review of the policy + ToS at
launch should be under $1000. Worth it.