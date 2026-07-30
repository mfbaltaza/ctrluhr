# Device lifecycle: revoke, don't delete; auth checks status

The docs contradict each other here, and the schema hides a landmine: doc 00
§3 promises working rotate/revoke ("daemon gets 401 and halts"), but doc 03
§5.4 verifies device JWTs statelessly (signature only, no expiry), so
revocation can never take effect. Meanwhile `activity_events.device_id` is
`ON DELETE CASCADE`: deleting a device from a tidy-up UI silently deletes its
entire event history. Decision:

1. **Devices are Revoked, not deleted** — a status column on `devices`;
   revoking cuts off ingest while event history keeps its provenance. A
   separate, explicit "delete device AND its history" action may exist for
   erasure, clearly marked destructive.
2. **Device auth is JWT signature + per-batch DB status check** — one indexed
   read per ingested batch; a Revoked device's key dies immediately. This
   makes doc 00 §3's promise true.
3. **Rotation = revoke + re-enroll**, so the `api_token_hash` dance
   (doc 03 §6.3, called overkill by the doc itself) is dropped.

## Consequences

- Schema changes before phase 1: add `devices.status`, drop
  `devices.api_token_hash`; the cascade remains only for the explicit
  destructive path.
- Doc corrections when next touched: `03` §5.4 (no longer stateless), `03`
  §6.3 (remove the hash), `00` §3 (claim now accurate).
- Ingest grows by one indexed read per ~10s batch — negligible.
