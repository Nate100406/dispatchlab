"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { terminal, type Accepted, type Detail } from "@dispatchlab/core";
import { api, detailLink } from "./api";
import Status from "./status";
export default function DeliveryView() {
  const id = useSearchParams().get("id");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(Date.now());
  const replayRequest = useRef<{
    source: string;
    recover: boolean;
    key: string;
  } | null>(null);
  const pollStart = useRef(0);
  const inFlight = useRef<{ id: string; controller: AbortController } | null>(
    null,
  );
  const polling = !!detail && !terminal(detail.delivery.state);
  const refresh = useCallback(async () => {
    if (!id || inFlight.current?.id === id) return;
    inFlight.current?.controller.abort();
    const request = { id, controller: new AbortController() };
    inFlight.current = request;
    try {
      const data = await api<Detail>(`/deliveries/${encodeURIComponent(id)}`, {
        signal: request.controller.signal,
      });
      if (!request.controller.signal.aborted) {
        setDetail(data);
        setError("");
      }
    } catch (e) {
      if (!request.controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (inFlight.current === request) inFlight.current = null;
    }
  }, [id]);
  useEffect(() => {
    pollStart.current = Date.now();
    setDetail(null);
    setError("");
    setPaused(false);
    void refresh();
    return () => {
      inFlight.current?.controller.abort();
      inFlight.current = null;
    };
  }, [id, refresh]);
  useEffect(() => {
    if (!id || !polling || paused) return;
    let refreshing = false;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - pollStart.current > 180000) {
        setPaused(true);
        clearInterval(timer);
        return;
      }
      if (!document.hidden && !refreshing) {
        refreshing = true;
        void refresh().finally(() => {
          refreshing = false;
        });
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [id, polling, paused, refresh]);
  async function replay(recover: boolean) {
    if (!id) return;
    setBusy(true);
    setError("");
    if (
      replayRequest.current?.source !== id ||
      replayRequest.current.recover !== recover
    )
      replayRequest.current = { source: id, recover, key: crypto.randomUUID() };
    try {
      const result = await api<Accepted>(`/deliveries/${id}/replay`, {
        method: "POST",
        body: JSON.stringify({ recover }),
        headers: { "Idempotency-Key": replayRequest.current.key },
      });
      window.location.assign(detailLink(result.deliveryId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!id)
    return (
      <div className="page">
        <h1>Choose a delivery.</h1>
        <Link href="/">Return to the lab →</Link>
      </div>
    );
  return (
    <div className="page detail-page">
      <Link className="back-link" href="/">
        ← All deliveries
      </Link>
      <div className="section-heading">
        <div>
          <p className="eyebrow">DELIVERY INSPECTOR</p>
          <h1 className="detail-title">Follow the attempt.</h1>
          <p className="mono muted delivery-id">{id}</p>
        </div>
        {detail && <Status state={detail.delivery.state} />}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!detail ? (
        <div className="panel loading">
          {error
            ? "Delivery data is unavailable."
            : "Loading the delivery timeline…"}
          <button className="secondary" onClick={refresh}>
            Refresh
          </button>
        </div>
      ) : (
        <>
          <div className="delivery-summary">
            <div>
              <span>RECEIVER</span>
              <b>{detail.delivery.receiver.behaviour.replaceAll("_", " ")}</b>
            </div>
            <div>
              <span>ATTEMPTS</span>
              <b>
                {detail.delivery.attempt_count}
                <small> / 5</small>
              </b>
            </div>
            <div>
              <span>EVENT TYPE</span>
              <b>{detail.event.event_type}</b>
            </div>
            <div>
              <span>DELIVERY MODEL</span>
              <b>At-least-once attempts</b>
            </div>
          </div>
          {detail.delivery.replay_parent_id && (
            <div className="notice">
              This is a replay.{" "}
              <Link href={detailLink(detail.delivery.replay_parent_id)}>
                Inspect the original delivery →
              </Link>
            </div>
          )}
          <div className="detail-grid">
            <section className="panel timeline">
              <div className="timeline-heading">
                <h2>Attempt timeline</h2>
                <button className="small-button" onClick={refresh}>
                  Refresh
                </button>
              </div>
              <div className="timeline-origin">
                <span className="timeline-dot" />
                <b>Event persisted</b>
                <p>Delivery intent committed in the same transaction.</p>
              </div>
              {detail.attempts.map((a) => (
                <article
                  key={a.attempt_number}
                  className={`attempt ${a.outcome}`}
                  data-testid="attempt"
                >
                  <span className="timeline-dot" />
                  <div className="attempt-top">
                    <h3>Attempt {a.attempt_number}</h3>
                    <span className="attempt-result">
                      {a.outcome === "started"
                        ? "In progress"
                        : a.outcome === "succeeded"
                          ? "Delivered"
                          : a.outcome === "interrupted"
                            ? "Outcome unknown"
                            : a.http_status
                              ? `HTTP ${a.http_status}`
                              : a.error_code === "timeout"
                                ? "Timed out"
                                : "Connection failed"}
                    </span>
                  </div>
                  <p>
                    {a.outcome === "interrupted"
                      ? "The worker was interrupted. The receiver may have processed this request."
                      : a.outcome === "succeeded"
                        ? "The receiver accepted the signed event."
                        : a.outcome === "started"
                          ? "A signed request is on its way to the receiver."
                          : `Delivery failed${a.duration_ms !== null ? ` after ${a.duration_ms} ms` : ""}.`}
                  </p>
                  <small>
                    {new Date(a.started_at).toLocaleTimeString()}{" "}
                    {a.duration_ms !== null && `· ${a.duration_ms} ms`}
                  </small>
                  {a.response_excerpt && (
                    <details>
                      <summary>Receiver response</summary>
                      <pre>{a.response_excerpt}</pre>
                    </details>
                  )}
                </article>
              ))}
              {detail.delivery.state === "retry_wait" && (
                <div className="timeline-end">
                  <span className="pulse-dot" />
                  <b>
                    {Date.parse(detail.delivery.next_attempt_at) <= now
                      ? "Retry is due; waiting for processing"
                      : `Next attempt in ${Math.ceil((Date.parse(detail.delivery.next_attempt_at) - now) / 1000)} seconds`}
                  </b>
                  <p>
                    Exponential backoff with jitter. The schedule is persisted.
                  </p>
                </div>
              )}
              {detail.delivery.state === "pending" && (
                <div className="timeline-end">
                  <b>
                    {now - Date.parse(detail.delivery.created_at) > 60000
                      ? "Queue processing is delayed"
                      : "Waiting for the queue"}
                  </b>
                  <p>
                    Accepted events remain durable if processing is delayed.
                  </p>
                </div>
              )}
              {terminal(detail.delivery.state) && (
                <div className={`timeline-end final ${detail.delivery.state}`}>
                  <b>
                    {detail.delivery.state === "succeeded"
                      ? "Delivery complete"
                      : "Final failure"}
                  </b>
                  <p>
                    {detail.delivery.state === "succeeded"
                      ? "All completed attempts remain available below."
                      : `Reason: ${detail.delivery.final_reason?.replaceAll("_", " ")}. Replay when you are ready.`}
                  </p>
                </div>
              )}
              {paused && !terminal(detail.delivery.state) && (
                <div className="notice">
                  Live updates paused after three minutes. Use Refresh to check
                  progress.
                </div>
              )}
            </section>
            <aside>
              <div className="payload-panel">
                <div className="code-heading">
                  <span>PERSISTED EVENT</span>
                  <span className="code-tag">JSON</span>
                </div>
                <pre>{JSON.stringify(detail.event.payload, null, 2)}</pre>
                <div className="code-foot">
                  <span className="dot" /> Immutable across retries and replays.
                </div>
              </div>
              <div className="panel replay-panel">
                <p className="eyebrow">RECOVERY</p>
                <h3>A new delivery. Same event.</h3>
                <p>
                  Replay keeps this timeline intact and starts a fresh
                  five-attempt budget.
                </p>
                <button
                  className="primary"
                  disabled={busy || !terminal(detail.delivery.state)}
                  onClick={() => replay(true)}
                >
                  Replay to success <span>↗</span>
                </button>
                <button
                  className="secondary"
                  disabled={busy || !terminal(detail.delivery.state)}
                  onClick={() => replay(false)}
                >
                  Replay original behaviour
                </button>
                <p className="fine-print">
                  Up to two replays per event. Receiver side effects may be
                  deduplicated by event ID.
                </p>
              </div>
            </aside>
          </div>
          {detail.replays.length > 0 && (
            <div className="panel replay-links">
              <h3>Linked replays</h3>
              {detail.replays.map((d) => (
                <Link key={d.id} href={detailLink(d.id)}>
                  {d.id.slice(0, 8)} → <Status state={d.state} />
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
