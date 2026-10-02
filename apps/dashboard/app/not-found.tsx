import Link from "next/link";
export default function NotFound() {
  return (
    <section className="page">
      <h1>This page isn’t in the lab.</h1>
      <Link href="/">Return to the delivery lab →</Link>
    </section>
  );
}
