import { Suspense } from "react";
import DeliveryView from "../../components/delivery-view";
export default function Page() {
  return (
    <Suspense fallback={<div className="page narrow">Loading delivery…</div>}>
      <DeliveryView />
    </Suspense>
  );
}
