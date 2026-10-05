import Link from "next/link";
export default function NotFound() {
  return (
    <section className="page">
      <h1>Page not found.</h1>
      <Link href="/">Return to the demo →</Link>
    </section>
  );
}
