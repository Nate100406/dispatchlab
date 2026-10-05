"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  samples,
  type Accepted,
  type Delivery,
  type Receiver,
} from "@dispatchlab/core";
import { api, ApiError, detailLink, startSession } from "./api";
import Status from "./status";
import { repository, scenarios, scenarioLabel } from "./copy";
import { Button, HistorySkeleton, JsonCode } from "./ui";
export default function Lab() {
  const router = useRouter();
  const [sample, setSample] = useState<keyof typeof samples>("order");
  const [behaviour, setBehaviour] =
    useState<Receiver["behaviour"]>("fail_then_succeed");
  const [failures, setFailures] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const pending = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    api<{ deliveries: Delivery[]; nextCursor: string | null }>(
      `/deliveries${filter ? `?status=${filter}` : ""}`,
    )
      .then((data) => {
        if (!cancelled) {
          setDeliveries(data.deliveries);
          setCursor(data.nextCursor);
          setListError("");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          if (e instanceof ApiError && e.status === 401) setDeliveries([]);
          else setListError(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const receiver: Receiver =
      behaviour === "fail_then_succeed"
        ? { behaviour, failures }
        : { behaviour };
    const body = JSON.stringify({ sampleId: sample, receiver });
    if (pending.current?.body !== body)
      pending.current = { body, key: crypto.randomUUID() };
    try {
      await startSession();
      const accepted = await api<Accepted>("/events", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": pending.current.key },
      });
      pending.current = null;
      router.push(detailLink(accepted.deliveryId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    if (!cursor || loadingMore || loadingList) return;
    setLoadingMore(true);
    try {
      const data = await api<{
        deliveries: Delivery[];
        nextCursor: string | null;
      }>(
        `/deliveries?cursor=${encodeURIComponent(cursor)}${filter ? `&status=${filter}` : ""}`,
      );
      setDeliveries((v) => [...v, ...data.deliveries]);
      setCursor(data.nextCursor);
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }
  return (
    <div className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">INTERACTIVE ENGINEERING DEMO</p>
          <h1>
            See how webhook delivery <span>handles failure.</span>
          </h1>
          <p className="hero-copy">
            Send a sample event, simulate a receiving service going offline, and
            watch automatic retries. Inspect every attempt, then replay failed
            deliveries.
          </p>
          <div className="hero-actions">
            <a className="text-link" href="#experiment">
              Try a delivery ↘
            </a>
            <a className="text-link" href={repository}>
              Explore the code and tests ↗
            </a>
          </div>
        </div>
        <div
          className="hero-diagram"
          aria-label="Save the event, send it in the background, then inspect the results"
        >
          <span className="diagram-caption">
            WHAT HAPPENS WHEN YOU CLICK SEND
          </span>
          <div className="flow-node">
            <span>01</span>
            <b>Save the event</b>
            <small>Store it before sending</small>
          </div>
          <div className="flow-line" />
          <div className="flow-node">
            <span>02</span>
            <b>Send and retry</b>
            <small>Process delivery in the background</small>
          </div>
          <div className="flow-line" />
          <div className="flow-node">
            <span>03</span>
            <b>Inspect the results</b>
            <small>See what happened on every attempt</small>
          </div>
          <div className="diagram-foot">
            Fictional events and services. Real delivery processing.
          </div>
        </div>
      </section>
      <div className="section-heading" id="experiment">
        <div>
          <p className="eyebrow">01 / TRY IT</p>
          <h2>Choose a scenario</h2>
        </div>
        <span className="muted">Fictional data. Real processing.</span>
      </div>
      <section className="experiment-grid">
        <form className="panel experiment-form" onSubmit={submit}>
          <h3>Send a sample event</h3>
          <p className="muted">
            A webhook is a message that tells another application something
            happened. Choose an example and decide how the test service
            responds.
          </p>
          <label htmlFor="sample">Sample event</label>
          <select
            id="sample"
            value={sample}
            onChange={(e) => setSample(e.target.value as keyof typeof samples)}
          >
            <option value="order">Order created</option>
            <option value="shipment">Shipment dispatched</option>
            <option value="invoice">Invoice paid</option>
          </select>
          <label htmlFor="receiver">
            How should the receiving service respond?
          </label>
          <select
            id="receiver"
            value={behaviour}
            onChange={(e) =>
              setBehaviour(e.target.value as Receiver["behaviour"])
            }
          >
            {Object.entries(scenarios).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {behaviour === "fail_then_succeed" && (
            <>
              <label htmlFor="failures">
                Failures before success <span>{failures}</span>
              </label>
              <input
                id="failures"
                type="range"
                min="0"
                max="4"
                value={failures}
                onChange={(e) => setFailures(Number(e.target.value))}
              />
              <div className="range-labels">
                <span>0 failures</span>
                <span>4 failures</span>
              </div>
            </>
          )}
          <div className="scenario-note" aria-live="polite">
            <strong>What to expect: </strong>
            {behaviour === "fail_then_succeed"
              ? failures === 0
                ? "The service should accept the event on the first attempt."
                : `The service will reject the first ${failures === 1 ? "attempt" : `${failures} attempts`}. DispatchLab should retry automatically and succeed on attempt ${failures + 1}.`
              : behaviour === "always_succeed"
                ? "The service should accept the event on the first attempt."
                : behaviour === "timeout"
                  ? "Each attempt stops after 3 seconds without a response. DispatchLab should retry, then stop after 5 attempts."
                  : behaviour === "rate_limit"
                    ? "The service returns HTTP 429. DispatchLab should wait at least 5 seconds between attempts, then stop after 5 attempts."
                    : "The service rejects every attempt with HTTP 503. DispatchLab should retry, then stop after 5 attempts."}
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button type="submit" className="primary" busy={busy}>
            {busy ? "Saving event…" : "Send event"}
            <span>↗</span>
          </Button>
          <p className="fine-print">
            No account needed. Up to 10 deliveries per session. Demo data is
            kept for 24 hours. All receiving services are controlled test
            services.
          </p>
        </form>
        <div className="payload-panel">
          <div className="code-heading">
            <span>EVENT DATA</span>
            <span className="code-tag">application/json</span>
          </div>
          <JsonCode
            value={{
              eventType: samples[sample].type,
              payload: samples[sample].payload,
            }}
          />
          <div className="code-foot">
            <span className="dot" /> This is the sample data DispatchLab will
            save and send.
          </div>
        </div>
      </section>
      <section className="delivery-list" aria-busy={loadingList || loadingMore}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">02 / ACTIVITY</p>
            <h2>Deliveries in this session</h2>
          </div>
          <label className="filter-label">
            Status
            <select
              aria-label="Filter deliveries"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="succeeded">Delivery successful</option>
              <option value="dead_lettered">Delivery stopped</option>
              <option value="retry_wait">Retry scheduled</option>
              <option value="pending">Queued</option>
              <option value="in_progress">Delivering</option>
            </select>
          </label>
        </div>
        {listError && (
          <p role="alert" className="error">
            {listError}
          </p>
        )}
        {loadingList ? (
          <HistorySkeleton />
        ) : deliveries.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Delivery</th>
                  <th>Scenario</th>
                  <th>Attempts</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link className="mono" href={detailLink(d.id)}>
                        {d.id.slice(0, 8)} ↗
                      </Link>
                      {d.replay_parent_id && (
                        <small className="replay-label">Replay</small>
                      )}
                    </td>
                    <td>{scenarioLabel(d.receiver)}</td>
                    <td>{d.attempt_count} / 5</td>
                    <td>
                      <Status state={d.state} />
                    </td>
                    <td>{new Date(d.created_at).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span>↗</span>
            <h3>{filter ? "No matching deliveries." : "No deliveries yet."}</h3>
            <p>
              {filter
                ? "Choose another status to see your history."
                : "Choose a scenario above and click Send event. Select a delivery here to see its results."}
            </p>
          </div>
        )}
        {cursor && !loadingList && (
          <Button className="secondary" onClick={more} busy={loadingMore}>
            Load more deliveries
          </Button>
        )}
      </section>
      <section id="how-it-works" className="principles">
        <div>
          <p className="eyebrow">03 / EXPLORE THE IMPLEMENTATION</p>
          <h2>What this demo demonstrates</h2>
        </div>
        <article>
          <b>Durable storage</b>
          <p>
            The event and its delivery plan are saved together in PostgreSQL
            before the request is accepted.
          </p>
          <a
            href={`${repository}/blob/main/docs/architecture.md#model-and-invariants`}
          >
            See the database design ↗
          </a>
        </article>
        <article>
          <b>Background processing</b>
          <p>
            A queue handles delivery after submission. Closing this page does
            not cancel the delivery.
          </p>
          <a href={`${repository}/blob/main/docs/architecture.md#decisions`}>
            See how processing works ↗
          </a>
        </article>
        <article>
          <b>Retries with a limit</b>
          <p>
            Temporary failures are retried with a delay, up to 5 attempts. Every
            result is recorded.
          </p>
          <a href={`${repository}/blob/main/tests/e2e/delivery.spec.ts`}>
            Explore the delivery tests ↗
          </a>
        </article>
        <article>
          <b>Signed requests</b>
          <p>
            The receiving service checks a signature to verify who sent the
            event and that it has not changed.
          </p>
          <a
            href={`${repository}/blob/main/docs/architecture.md#hmac-contract`}
          >
            Read about request signing ↗
          </a>
        </article>
        <article>
          <b>Recovery with history</b>
          <p>
            Replay starts a new delivery while keeping the original history. A
            service may receive the same event more than once.
          </p>
          <a href={`${repository}/blob/main/tests/integration/system.test.ts`}>
            Explore the recovery tests ↗
          </a>
        </article>
      </section>
    </div>
  );
}
