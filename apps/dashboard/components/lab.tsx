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
export default function Lab() {
  const router = useRouter();
  const [sample, setSample] = useState<keyof typeof samples>("order");
  const [behaviour, setBehaviour] =
    useState<Receiver["behaviour"]>("fail_then_succeed");
  const [failures, setFailures] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const pending = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
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
    if (!cursor) return;
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
    }
  }
  return (
    <div className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">THE WEBHOOK DELIVERY LAB</p>
          <h1>
            Every event.
            <br />
            <span>Every attempt.</span>
          </h1>
          <p className="hero-copy">
            Send an event into the wild. Watch it fail, retry, and find its way
            home. A small lab for the parts of delivery that matter.
          </p>
          <a className="text-link" href="#experiment">
            Run your first experiment <span>↘</span>
          </a>
        </div>
        <div
          className="hero-diagram"
          aria-label="Events are persisted, queued, delivered, and inspected"
        >
          <span className="diagram-caption">
            ONE EVENT. A COMPLETE JOURNEY.
          </span>
          <div className="flow-node">
            <span>01</span>
            <b>Persist</b>
            <small>PostgreSQL transaction</small>
          </div>
          <div className="flow-line" />
          <div className="flow-node">
            <span>02</span>
            <b>Dispatch</b>
            <small>Asynchronous queue</small>
          </div>
          <div className="flow-line" />
          <div className="flow-node">
            <span>03</span>
            <b>Observe</b>
            <small>Every attempt recorded</small>
          </div>
          <div className="diagram-foot">
            ↻ &nbsp; Failure is part of the experiment.
          </div>
        </div>
      </section>
      <div className="section-heading" id="experiment">
        <div>
          <p className="eyebrow">01 / EXPERIMENT</p>
          <h2>Put delivery to the test.</h2>
        </div>
        <span className="muted">Fictional data. Real processing.</span>
      </div>
      <section className="experiment-grid">
        <form className="panel experiment-form" onSubmit={submit}>
          <h3>Send a sample event</h3>
          <p className="muted">
            No account needed. Your session is private and lasts 24 hours.
          </p>
          <label htmlFor="sample">Event</label>
          <select
            id="sample"
            value={sample}
            onChange={(e) => setSample(e.target.value as keyof typeof samples)}
          >
            <option value="order">Order created</option>
            <option value="shipment">Shipment dispatched</option>
            <option value="invoice">Invoice paid</option>
          </select>
          <label htmlFor="receiver">Receiver behaviour</label>
          <select
            id="receiver"
            value={behaviour}
            onChange={(e) =>
              setBehaviour(e.target.value as Receiver["behaviour"])
            }
          >
            <option value="always_succeed">Always succeed</option>
            <option value="fail_then_succeed">Fail, then succeed</option>
            <option value="always_fail">Always fail</option>
            <option value="timeout">Timeout</option>
            <option value="rate_limit">Return 429</option>
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
          <div className="scenario-note">
            {behaviour === "fail_then_succeed"
              ? `The receiver will return 503 ${failures} time${failures === 1 ? "" : "s"}, then accept the event.`
              : behaviour === "always_succeed"
                ? "The receiver accepts the very first attempt."
                : behaviour === "timeout"
                  ? "The receiver takes too long. Each attempt times out after 3 seconds."
                  : behaviour === "rate_limit"
                    ? "The receiver returns 429 and requests a 5-second delay."
                    : "The receiver returns 503 until the five-attempt budget is exhausted."}
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Persisting event…" : "Send event"}
            <span>↗</span>
          </button>
          <p className="fine-print">
            Up to 10 deliveries per session. Controlled receivers only.
          </p>
        </form>
        <div className="payload-panel">
          <div className="code-heading">
            <span>PAYLOAD PREVIEW</span>
            <span className="code-tag">application/json</span>
          </div>
          <pre>
            {JSON.stringify(
              {
                eventType: samples[sample].type,
                payload: samples[sample].payload,
              },
              null,
              2,
            )}
          </pre>
          <div className="code-foot">
            <span className="dot" /> This exact event is persisted before
            delivery begins.
          </div>
        </div>
      </section>
      <section className="delivery-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">02 / ACTIVITY</p>
            <h2>Your deliveries</h2>
          </div>
          <label className="filter-label">
            Status
            <select
              aria-label="Filter deliveries"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="succeeded">Succeeded</option>
              <option value="dead_lettered">Final failure</option>
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
        {deliveries.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Delivery</th>
                  <th>Receiver</th>
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
                    <td>{d.receiver.behaviour.replaceAll("_", " ")}</td>
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
            <h3>
              {filter
                ? "No matching deliveries."
                : "Your first event starts here."}
            </h3>
            <p>
              {filter
                ? "Choose another status to see your history."
                : "Send a sample event above to see its journey, one attempt at a time."}
            </p>
          </div>
        )}
        {cursor && (
          <button className="secondary" onClick={more}>
            Load more deliveries
          </button>
        )}
      </section>
      <section id="how-it-works" className="principles">
        <div>
          <p className="eyebrow">DESIGNED FOR THE UNHAPPY PATH</p>
          <h2>
            Small system.
            <br />
            Clear guarantees.
          </h2>
        </div>
        <article>
          <b>Durable before accepted</b>
          <p>
            Events and delivery intent commit together. Queue publication can
            recover independently.
          </p>
        </article>
        <article>
          <b>Bounded, visible retries</b>
          <p>
            Five attempts, exponential backoff, and an immutable record of
            completed attempts.
          </p>
        </article>
        <article>
          <b>History stays intact</b>
          <p>
            Replay creates a linked delivery. Duplicate receipt is possible;
            exactly-once delivery is not promised.
          </p>
        </article>
      </section>
    </div>
  );
}
