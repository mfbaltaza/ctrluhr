# Day boundaries are user-local

Docs 03/04 bucket analytics and the dashboard's "today" by UTC midnight, and
`habit_checkins.day` is a bare date. For any User off UTC, evening activity
lands on the wrong day, dashboards look empty while the User is working, and
streaks misfire. Decision: each User has an IANA timezone setting (default
detected from the browser at first login); **every day-bucket — analytics,
habit check-ins, streaks, recaps — is computed in the User's own timezone**,
while event storage stays UTC `timestamptz`.

## Consequences

- Stored habit check-ins are materialized under the timezone at computation
  time; changing the timezone setting later does not rewrite history.
- Events recorded while traveling bucket by the User's home timezone.
- Doc corrections needed when those files are next touched: `03-api-setup.md`
  §8.3 (date handling) and `04-web-setup.md` dashboard "today" must use the
  User's timezone, not UTC.
