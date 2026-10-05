"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="page state-page">
      <h1>The page could not load.</h1>
      <p>
        This page error does not cancel saved deliveries. Try loading the page
        again.
      </p>
      <button className="primary" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
