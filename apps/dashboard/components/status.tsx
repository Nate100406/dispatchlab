import type { DeliveryState } from "@dispatchlab/core";
const labels: Record<DeliveryState, string> = {
  pending: "Queued",
  in_progress: "Delivering",
  retry_wait: "Retry scheduled",
  succeeded: "Succeeded",
  dead_lettered: "Final failure",
};
export default function Status({ state }: { state: DeliveryState }) {
  return (
    <span className={`status ${state}`}>
      <span className="dot" />
      {labels[state]}
    </span>
  );
}
