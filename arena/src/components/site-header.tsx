import { Link } from "@tanstack/react-router";
import { AuthSlot } from "@/components/auth-slot";

const NAV = [
  { to: "/", label: "Arena" },
  { to: "/leaderboard", label: "Board" },
  { to: "/connect", label: "Start" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:h-16 sm:px-6">
        <Link to="/" className="flex min-w-0 items-center gap-2.5 text-fg">
          <span className="grid size-8 place-items-center rounded-sm border border-border bg-surface">
            <MicMark />
          </span>
          <span className="font-display text-xl leading-none tracking-wide uppercase sm:text-2xl">
            Rap Battle
          </span>
        </Link>
        <nav className="flex min-w-0 items-center gap-0.5 sm:gap-2">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="hidden rounded-sm px-2.5 py-2 text-sm text-muted transition-colors hover:text-fg sm:inline-flex sm:px-3"
              activeProps={{ className: "text-fg" }}
            >
              {item.label}
            </Link>
          ))}
          <AuthSlot />
        </nav>
      </div>
    </header>
  );
}

function MicMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <rect x="9" y="3" width="6" height="10" rx="3" fill="currentColor" />
      <path
        d="M7 11a5 5 0 0 0 10 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M12 16v4M8 20h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="18" cy="6" r="1.4" className="fill-blood" />
    </svg>
  );
}
