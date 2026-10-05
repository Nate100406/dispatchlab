import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  busy = false,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <span className="button-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function JsonCode({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? "";
  const tokens: ReactNode[] = [];
  const pattern =
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    tokens.push(text.slice(position, index));
    const kind = match[2]
      ? "key"
      : match[1]
        ? "value"
        : match[3]
          ? "literal"
          : "number";
    tokens.push(
      <span className={`json-${kind}`} key={index}>
        {match[0]}
      </span>,
    );
    position = index + match[0].length;
  }
  tokens.push(text.slice(position));
  return <pre>{tokens}</pre>;
}

export function HistorySkeleton() {
  return (
    <div className="list-skeleton" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div className="skeleton-row" key={row}>
          <span />
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
