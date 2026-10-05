import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
export const metadata: Metadata = {
  title: "DispatchLab — delivery, made visible",
  description:
    "An inspectable webhook delivery lab. Send, retry, and replay controlled events.",
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
            <Link href="/">Delivery lab</Link>
            <a href="/#how-it-works">How it works</a>
          </nav>
          <span className="demo-label">
            <span className="dot" /> Controlled demo
          </span>
        </header>
        <main>{children}</main>
        <footer>
          <span>DispatchLab / v1</span>
          <span>Persisted events. Visible failures. Recoverable delivery.</span>
          <a href="https://github.com/Nate100406/dispatchlab">
            Source, tests & architecture ↗
          </a>
        </footer>
      </body>
    </html>
  );
}
