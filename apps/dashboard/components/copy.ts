import type { Attempt, Receiver } from "@dispatchlab/core";

export const repository = "https://github.com/Nate100406/dispatchlab";
export const scenarios: Record<Receiver["behaviour"], string> = {
  always_succeed: "Accept immediately",
  fail_then_succeed: "Fail temporarily, then recover",
  always_fail: "Keep returning an error",
  timeout: "Respond too slowly",
  rate_limit: "Busy — try again later (429)",
};

export function scenarioLabel(receiver: Receiver) {
  return receiver.behaviour === "fail_then_succeed"
    ? `Recover after ${receiver.failures} failed attempt${receiver.failures === 1 ? "" : "s"}`
    : scenarios[receiver.behaviour];
}

export function attemptExplanation(attempt: Attempt) {
  if (attempt.outcome === "interrupted")
    return "Processing stopped before a result was saved. The service may have received the event.";
  if (attempt.outcome === "succeeded")
    return "The receiving service accepted the signed event.";
  if (attempt.outcome === "started")
    return "Sending the saved event to the receiving service.";
  if (attempt.error_code === "timeout")
    return "The receiving service did not respond within 3 seconds.";
  if (attempt.http_status === 429)
    return "The receiving service is busy and asked DispatchLab to wait before trying again.";
  if (attempt.http_status !== null && attempt.http_status >= 500)
    return "The receiving service is temporarily unavailable.";
  if (attempt.http_status !== null)
    return "The receiving service did not accept the event.";
  return "DispatchLab could not connect to the receiving service.";
}

export function stoppedExplanation(reason: string | null, attempts: number) {
  if (reason === "attempts_exhausted")
    return `None of the ${attempts} attempts had a confirmed success. The event and attempt history are saved. You can replay the delivery below.`;
  if (reason === "permanent_rejection")
    return "The service rejected the event with a response that should not be retried automatically. You can inspect the response and replay below.";
  return "Background processing could not continue. The event and attempt history are saved. You can replay the delivery below.";
}
