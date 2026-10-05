import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
export const metadata: Metadata = {
  title: "DispatchLab — webhook delivery demo",
  description:
    "An interactive engineering demo. Trigger delivery failures, watch automatic retries, and inspect how the system recovers.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            <span className="brand-mark">↗</span>Dispatch<span>Lab</span>
          </Link>
          <nav aria-label="Main">
            <Link href="/">Try the demo</Link>
            <a href="/#how-it-works">What it demonstrates</a>
          </nav>
          <span className="demo-label">
            <span className="dot" /> Interactive demo
          </span>
        </header>
        <main>{children}</main>
        <footer>
          <span>DispatchLab / v1</span>
          <span>Sample events. Real delivery, retries and recovery.</span>
          <a href="https://github.com/Nate100406/dispatchlab">
            Explore the code and tests ↗
          </a>
        </footer>
      </body>
    </html>
  );
}
