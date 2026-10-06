# Implementation and evidence

| Phase | Deliverable                                                        | Verification gate                                                                              |
| ----- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 0     | Architecture, decisions, scope and defaults                        | Documents tracked alongside code                                                               |
| 1     | Workspaces, static dashboard, Worker runtime, local PostgreSQL, CI | Clean setup, static build, Worker DB smoke                                                     |
| 2     | Schema, sessions, ingestion, quotas, idempotency                   | Real PostgreSQL atomicity and concurrency tests                                                |
| 3     | Outbox, queue claim, attempt history, HMAC                         | Signed asynchronous delivery reaches verified receiver                                         |
| 4     | Retry policy, all receiver behaviours, leases, recovery            | Crash and stale-worker tests, final failure                                                    |
| 5     | Replay, recovery option, lineage and limits                        | Same event, preserved history, duplicate replay suppression                                    |
| 6     | Polished scenario interface and live timeline                      | Both browser E2E journeys, mobile and accessibility checks                                     |
| 7     | Abuse controls, deployment workflow, runbook, README               | CI, configuration audit, clean checkout setup; hosted smoke requires configured cloud accounts |

Tests are inspectable under `tests/`: fast policy/signature tests; integration tests use independent PostgreSQL connections and actual handlers; browser tests exercise the built assets, local queue, and private receiver binding. Test-only crash simulations never become API endpoints. CI requires no cloud credentials.

Public launch is a separate operation: provision free resources, set matching signing secrets and least-privileged DB credentials, run migrations using owner credentials, deploy receiver then app, and run the hosted smoke checklist. Never claim hosted verification from local tests.

## Verification record

The October 5, 2026 audit passes: 30 unit tests, 27 real PostgreSQL integration tests, and eight browser tests (65 total), plus formatting, lint, TypeScript, static export, and both Worker bundles. Four browser tests exercise real delivery paths; four isolate browser faults and asset headers. A 390-pixel viewport has no horizontal overflow or browser exceptions. The local application uses the restricted PostgreSQL runtime role.

GitHub Actions previously passed the original release checks on a fresh Ubuntu checkout. Audit changes must also pass CI before release. The development proxy was separately verified with a real signed delivery and an active Next.js hot-reload WebSocket.

The free hosted demo was subsequently provisioned and checked on October 5, 2026. The [hosted verification report](hosted-demo.md) records the separate smoke gate, security checks and measured runtime constraints. No paid resources were provisioned. Free-provider limits and application quotas can temporarily pause demo availability.
