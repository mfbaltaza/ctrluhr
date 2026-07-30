# ctrluhr

ctrluhr is a multi-user time-tracking system for habit construction: it records
focused application/window activity per user, categorizes it, and feeds
analytics, habits, and (later) AI suggestions. One instance is hosted by an
Operator and serves many Users.

## Language

**User**:
A person with an account on a ctrluhr instance who tracks their own activity.
Owns their devices, events, categories, and habits; no User can see another
User's data.
_Avoid_: account, customer, client

**Operator**:
The person who hosts and runs the ctrluhr instance (API + database); currently
also a User. From phase 1, content fields are client-side encrypted
(ADR-0002), so the Operator can read metadata (timestamps, categories,
devices) but not activity content.
_Avoid_: admin, owner

**Membership**:
How someone becomes a User: open signup. Anyone who can reach the instance can
create an account with any email via magic link.
_Avoid_: invite, allowlist

**Uncategorized queue**:
The set of a User's Activity Events with no Category assigned, awaiting
automatic or manual categorization.
_Avoid_: inbox, unlabeled events

**Relabel**:
Manual assignment of a Category to an Activity Event by the User in the web
app. Only touches the event's category reference (plaintext), never
re-encrypts content.
_Avoid_: retag, reclassify (reclassification is the bulk, automatic variant)

**Activity Event**:
One recorded span of focus on a single app + window-title pair on a single
Device, capped at the heartbeat length — a long focus is many consecutive
Events. Events tile tracked time per device: gaps between them mean untracked
time (idle, paused, daemon off), and overlapping time across Devices is
counted as recorded. Insert-only — the only permitted mutations are Relabel
and delete.
_Avoid_: session, sample, tick

**Day**:
A calendar day in the User's own timezone (an IANA setting on the User,
defaulting from the browser). All bucketing — analytics, Habit check-ins,
streaks — uses User-local midnights; event storage stays UTC.
_Avoid_: UTC day, server day

**Category**:
A User-owned named bucket that Activity Events are classified into — unique
per User by name, with a color and a Productivity. "Uncategorized" is not a
Category; it is the absence of one.
_Avoid_: label, tag, group

**Productivity**:
A Category's tri-state classification: distracting (−1), neutral (0), or
productive (+1). Always evaluated live — every Activity Event in a Category
reflects the Category's current value, including historical events.
_Avoid_: score, rating

**Rule**:
A pattern belonging to a Category that auto-assigns it to matching Activity
Events, evaluated by the daemon: either an exact app-name match or a title
regex. Evaluation order is title regexes first, then app names; first hit
wins.
_Avoid_: filter, trigger, priority

**Device**:
A machine running one ctrluhr daemon, enrolled by a User. Devices are
Revoked, not deleted: revoking cuts off ingest (the daemon gets 401) but
preserves the device's event history.
_Avoid_: machine, client, installation

**Enrollment Token**:
A one-time, short-lived (~30 minutes) secret created by a User in the web app
to enroll a new Device; exchanged exactly once for a Device Key.
_Avoid_: voucher, verification token

**Device Key**:
The long-lived JWT a daemon presents on every ingest call; identifies the
Device and its owning User. Valid until its Device is Revoked.
_Avoid_: api_token, API key

**Habit**:
A User's commitment to spend at least a target number of minutes per Day in a
linked Category, or a manually-confirmed daily practice with no linked
Category.
_Avoid_: goal, routine

**Check-in**:
The record of one Habit for one Day — minutes achieved and whether the target
was met. Derived automatically from Activity Events for linked Habits, or
entered by the User; a manual Check-in is sticky and is never overwritten by
auto-derivation.
_Avoid_: log, entry

**Streak**:
The count of consecutive Days with an achieved Check-in for a Habit. Derived
at query time, never stored.
_Avoid_: chain
