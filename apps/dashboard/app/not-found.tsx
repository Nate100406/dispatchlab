import Link from "next/link";
export default function NotFound() {
  return (
    <section className="page state-page">
      <h1>Page not found.</h1>
      <Link className="secondary" href="/">
        Return to the demo →
      </Link>
    </section>
  );
}
