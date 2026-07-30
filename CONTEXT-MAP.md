# Context Map

## Contexts

- [ctrluhr domain](./CONTEXT.md) — shared language for the whole system: users, devices, events, categories, habits.

Per-app contexts (`apps/api`, `apps/daemon`, `apps/web`, `packages/schema`) are
created lazily — a `CONTEXT.md` appears in an app only when a term specific to
that app is resolved.

## Relationships

- **daemon → api**: daemon batches Activity Events to the API over HTTPS (device auth).
- **web → api**: web reads analytics and manages categories/devices/habits (user session auth).
- **packages/schema ↔ all**: source of truth for the wire format between daemon, api, and web.
