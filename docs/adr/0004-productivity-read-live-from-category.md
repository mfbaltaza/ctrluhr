# Productivity is read live from the category

Doc 00 §4 snapshots `category.is_productive` onto each event at ingest time,
arguing analytics should reflect "what the user believed at the time".
Decision: reversed. **An event's productivity is always its category's
current flag, evaluated at query time.** When a User realizes YouTube was a
distraction all along, reclassifying the category must correct history — the
snapshot would permanently preserve the mistake. Two coexisting meanings of
"productive" (snapshot vs current) would be a permanent vocabulary collision.

## Consequences

- `activity_events.productive` is dropped from the schema; `categories.is_productive`
  is the single source of truth. *(Applied — `20260805220511_pre_phase1_schema_batch`.)*
- Analytics queries join categories for the flag (they already LEFT JOIN for
  the name — no new cost).
- Uncategorized events have no productivity (NULL category), unchanged.
- Doc corrections needed when those files are next touched: `00` §4 design
  note (snapshot rationale), `02` activity-events schema, `03` events route
  (stop inserting `productive`).
