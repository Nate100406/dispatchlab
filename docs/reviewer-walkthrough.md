# DispatchLab: a five-minute walkthrough

## The problem

An online shop accepts an order and needs to notify a shipping application. The shipping application is temporarily offline. The order notification should survive that outage, and someone should be able to inspect what happened.

DispatchLab saves the event and delivery intent, sends a signed request in the background, retries temporary failures, and keeps an attempt history. Its demo receivers deliberately fail so this behaviour can be observed. They do not fulfil real orders.

## Try the delivery flow

1. Send **Order created → Fail, then succeed → 2 failures**. Expect HTTP 503, 503, then success. Expand the successful receiver response to see signature verification.
2. Reload the detail page. The attempt history comes from PostgreSQL; browser state does not own delivery progress.
3. Send **Always fail**. After five attempts, replay to success. Inspect the link back to the original delivery: its history remains intact.
4. Try **Timeout** or **Return 429**. A slow receiver is bounded by a three-second timeout; a 429 requests at least five seconds before the next attempt.
5. Open the tests and architectural decisions below. A demo shows behaviour; regression tests establish the important boundaries.

## What to inspect

| Engineering question                                             | Implementation                                                        | Inspectable evidence                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Can acceptance lose delivery intent?                             | Event, delivery, quota, idempotency record and outbox commit together | Integration tests for atomicity, rollback and failed publication      |
| What if a client repeats a request?                              | Scoped key + canonical fingerprint, protected by a session row lock   | Concurrent-ingestion test and browser lost-response test              |
| Can two consumers send the same scheduled attempt?               | Row lock, generation and lease token                                  | Competing claim, obsolete message and stale finalisation tests        |
| What if a worker pauses while waiting for a DB lock?             | Lease checked against database time after acquiring the lock          | Lock-contention lease-expiry regression                               |
| What if a receiver accepted a request before the worker crashed? | Interrupted attempt with unknown outcome; bounded retry               | Crash-after-acceptance test; duplicate receipt is explicitly possible |
| Can a replay erase evidence?                                     | New delivery linked to the same immutable event                       | Replay lineage and immutable-history tests                            |
| Can anonymous visitors target arbitrary servers?                 | Preset behaviour only; private receiver binding; no destination input | Validation and hosted-mode API tests, deployment exposure checklist   |

Start with [architecture](architecture.md), `packages/db/src/index.ts`, `tests/integration/system.test.ts`, and `tests/e2e/delivery.spec.ts`. Browser-only fault cases are in `tests/e2e/resilience.spec.ts` and use intercepted responses; the delivery journeys use real PostgreSQL and local queue processing.

## Design limitations

- Delivery attempts are bounded and can produce duplicate receipt. Exactly-once external side effects would require receiver cooperation.
- PostgreSQL owns scheduling; the queue wakes workers. A transactional outbox covers the database/queue dual-write gap.
- A half-hour recovery sweep trades recovery latency for free-tier compute usage. Batches and infrastructure outages can add more delay.
- The local emulator cannot establish production queue concurrency or free-plan CPU feasibility. Database races are separately tested; cloud validation is a release gate.
- This is a focused engineering demonstration. It has no real shipping integration, arbitrary destinations, billing or accounts.
