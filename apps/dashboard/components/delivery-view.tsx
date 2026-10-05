"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { terminal, type Accepted, type Detail } from "@dispatchlab/core";
import { api, detailLink } from "./api";
import Status from "./status";
import { attemptExplanation, scenarioLabel, stoppedExplanation } from "./copy";
import { Button, JsonCode } from "./ui";
export default function DeliveryView() {
  const id = useSearchParams().get("id");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [replayAction, setReplayAction] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
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
  const refresh = useCallback(
    async (showProgress = false) => {
      if (!id || inFlight.current?.id === id) return;
      inFlight.current?.controller.abort();
      const request = { id, controller: new AbortController() };
      inFlight.current = request;
      if (showProgress) setRefreshing(true);
      try {
        const data = await api<Detail>(
          `/deliveries/${encodeURIComponent(id)}`,
          {
            signal: request.controller.signal,
          },
        );
        if (!request.controller.signal.aborted) {
          setDetail(data);
          setError("");
        }
      } catch (e) {
        if (!request.controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (inFlight.current === request) {
          inFlight.current = null;
          setRefreshing(false);
        }
      }
    },
    [id],
  );
  useEffect(() => {
    pollStart.current = Date.now();
    setDetail(null);
    setError("");
    setPaused(false);
    setRefreshing(false);
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
    setReplayAction(recover);
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
      <div className="page state-page">
        <h1>Choose a delivery.</h1>
        <Link className="secondary" href="/">
          Return to the lab →
        </Link>
      </div>
    );
  return (
    <div className="page detail-page">
      <Link className="back-link" href="/">
        ← All deliveries
      </Link>
      <div className="section-heading">
        <div>
          <p className="eyebrow">SEE WHAT HAPPENED</p>
          <h1 className="detail-title">Delivery results</h1>
          <p className="mono muted delivery-id">Delivery ID: {id}</p>
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
          <Button
            className="secondary"
            onClick={() => void refresh(true)}
            busy={refreshing}
          >
            Refresh
          </Button>
        </div>
      ) : (
        <>
          <div className="delivery-summary">
            <div>
              <span>SCENARIO</span>
              <b>{scenarioLabel(detail.delivery.receiver)}</b>
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
              <span>PROCESSING</span>
              <b>Runs in the background</b>
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
                <Button
                  className="small-button"
                  onClick={() => void refresh(true)}
                  busy={refreshing}
                >
                  Refresh
                </Button>
              </div>
              <div className="timeline-origin">
                <span className="timeline-dot" />
                <b>Event saved</b>
                <p>The event is stored before delivery begins.</p>
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
                  <p>{attemptExplanation(a)}</p>
                  <small>
                    {new Date(a.started_at).toLocaleTimeString()}{" "}
                    {a.duration_ms !== null && `· ${a.duration_ms} ms`}
                  </small>
                  {a.response_excerpt && (
                    <details>
                      <summary>View service response</summary>
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
                      ? "Waiting for the next attempt to start"
                      : `Trying again in ${Math.ceil((Date.parse(detail.delivery.next_attempt_at) - now) / 1000)} seconds`}
                  </b>
                  <p>
                    DispatchLab retries automatically. Delays vary and can grow
                    after repeated failures.
                  </p>
                </div>
              )}
              {detail.delivery.state === "pending" && (
                <div className="timeline-end">
                  <b>
                    {now - Date.parse(detail.delivery.created_at) > 60000
                      ? "Delivery is taking longer to start"
                      : "Waiting to send"}
                  </b>
                  <p>
                    The event is saved. Background processing will pick it up
                    when available.
                  </p>
                </div>
              )}
              {terminal(detail.delivery.state) && (
                <div className={`timeline-end final ${detail.delivery.state}`}>
                  <b>
                    {detail.delivery.state === "succeeded"
                      ? "Delivery successful"
                      : "Delivery stopped"}
                  </b>
                  <p>
                    {detail.delivery.state === "succeeded"
                      ? `The receiving service accepted the event on attempt ${detail.delivery.attempt_count}. You can inspect each attempt above.`
                      : stoppedExplanation(
                          detail.delivery.final_reason,
                          detail.delivery.attempt_count,
                        )}
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
                  <span>SAVED EVENT DATA</span>
                  <span className="code-tag">JSON</span>
                </div>
                <JsonCode value={detail.event.payload} />
                <div className="code-foot">
                  <span className="dot" /> Retries and replays use the same
                  event data.
                </div>
              </div>
              <div className="panel replay-panel">
                <p className="eyebrow">TRY AGAIN</p>
                <h3>Replay this event</h3>
                <p>
                  Replay creates a new delivery of the same event and keeps this
                  history intact. Repeat the scenario or use a working receiver
                  that accepts the first attempt.
                </p>
                <Button
                  className="primary"
                  disabled={busy || !terminal(detail.delivery.state)}
                  busy={busy && replayAction === true}
                  onClick={() => replay(true)}
                >
                  {busy && replayAction === true
                    ? "Starting replay…"
                    : "Replay with a working receiver"}{" "}
                  <span>↗</span>
                </Button>
                <Button
                  className="secondary"
                  disabled={busy || !terminal(detail.delivery.state)}
                  busy={busy && replayAction === false}
                  onClick={() => replay(false)}
                >
                  Repeat this scenario
                </Button>
                <p className="fine-print">
                  {terminal(detail.delivery.state)
                    ? "Up to 2 replays per event. A service may receive the same event more than once."
                    : "Replay becomes available when this delivery finishes."}
                </p>
              </div>
            </aside>
          </div>
          {detail.replays.length > 0 && (
            <div className="panel replay-links">
              <h3>Replays of this delivery</h3>
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
