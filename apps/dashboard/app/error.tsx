"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="page">
      <h1>Something interrupted the dashboard.</h1>
      <p>
        Your persisted deliveries are still available. Try loading the view
        again.
      </p>
      <button onClick={reset}>Try again</button>
    </section>
  );
}
