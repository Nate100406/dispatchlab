# Hosted DispatchLab demo

Public address: **https://dispatchlab.nate-26e.workers.dev**

Provisioned and checked on 2026-10-05. This is a bounded public demonstration with fictional events and controlled receivers.

## Hosting and cost controls

- Cloudflare Workers Free was verified as the account's current $0 plan. Static assets, one delivery queue, and one Hyperdrive configuration use included free allowances. No paid upgrade was enabled.
- Neon Free was verified as the organization's current $0 plan. PostgreSQL 17 compute is capped at 0.25 CU with five-minute scale-to-zero. No paid add-ons were enabled.
- Application admission is capped at 50 deliveries and 200 new sessions globally per UTC day, 10 deliveries per session, five attempts per delivery, and two replays per event. Retention is 24 hours; recovery runs every 30 minutes. Provider quotas can suspend availability rather than create free-plan overage charges.
- The Hyperdrive origin connection limit is configured as five, and query caching is disabled. Health checks do not query or wake the database. Polling stops after three minutes.

Current provider references: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), and [Neon Free limits](https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md).

## Security checks

- Runtime PostgreSQL role has only schema USAGE and SELECT/INSERT/UPDATE/DELETE on the seven application tables. It cannot create schema objects or read the migration table. Migrations use a separate owner connection.
- Database and signing values were transferred through protected stdin or memory. Local deployment credentials are in the OS keychain, not source or local environment examples.
- Hosted session cookies are Secure, HttpOnly and SameSite=Strict. Another visitor receives 404 for a private delivery; anonymous reads receive 401.
- Hosted input accepts fictional presets only. Custom payloads, destination URL injection and foreign POST origins were rejected.
- Receiver workers.dev and preview URLs are disabled. The account has no Worker custom domains or zones exposing it. Requests reach it through the main Worker's private service binding and are HMAC signed.
- Browser responses apply content-security, no-sniff and referrer policies. Production package audit reported no published vulnerabilities.

## Hosted behavior gate

The hosted suite verifies immediate success, 503 failures capped at five attempts, three-second timeouts, 429 Retry-After delays, replay to a working receiver with original history unchanged, idempotent acceptance, session isolation, input restrictions and private receiver exposure. The browser separately verified two failures followed by signed success on attempt three.

Runtime timings are measured on Cloudflare rather than inferred from local tests. Free HTTP CPU allowance remains 10 ms; cold or heavier operations can exceed it and Cloudflare may terminate sustained excess. This demo is not a production capacity or availability guarantee, and paid upgrades are not a fallback.

The final smoke run recorded ordinary timeline polling at approximately 2–5 ms CPU, with all captured invocation outcomes `ok`. Initial session and event/replay operations measured up to 21 ms in that run; provider flexibility allowed them, which is not a guarantee under sustained load. Direct database handshakes were replaced by the free pool, and timeline reads were reduced from seven statements to one snapshot query. User wording and delivery guarantees were preserved.

## Releases

Source and local checks are public at [GitHub](https://github.com/Nate100406/dispatchlab). The live application was published with the account owner's approved Wrangler connection. GitHub's manual deploy workflow requires a successful CI run for the exact commit and its separate production-environment release credentials. The production environment permits only main. See [the runbook](runbook.md) for deployment and recovery.
