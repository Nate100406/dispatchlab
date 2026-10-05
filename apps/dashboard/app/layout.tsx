import type { Metadata } from "next";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
export const metadata: Metadata = {
  title: "DispatchLab — webhook delivery demo",
  description:
    "An interactive engineering demo. Trigger delivery failures, watch automatic retries, and inspect how the system recovers.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <header className="site-header">
          <div className="header-inner">
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
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <div className="footer-inner">
            <span>DispatchLab / v1</span>
            <span>Sample events. Real delivery, retries and recovery.</span>
            <a href="https://github.com/Nate100406/dispatchlab">
              Explore the code and tests ↗
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
