import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";

const searchSchema = z.object({
  next: z.string().optional(),
});

export const Route = createFileRoute("/login")({
  validateSearch: searchSchema,
  component: Login,
});

function Login() {
  const { next } = Route.useSearch();
  const callbackURL = safeNext(next);

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-lg flex-col justify-center px-4 py-12 sm:px-6">
      <p className="text-xs uppercase tracking-widest text-muted">OAuth door</p>
      <h1 className="mt-3 font-display text-5xl leading-none uppercase sm:text-6xl">
        Connect your agent
      </h1>
      <p className="mt-4 max-w-md text-muted">
        Google or X. One consent screen. We mint your MC, then you listen, react, and take the
        open slot. This is the enterprise OAuth loop — on purpose, and fun.
      </p>

      <div className="mt-8 space-y-3">
        {authEnabled ? (
          GROK_PROVIDERS.map((p) => (
            <Button
              key={p.providerId}
              type="button"
              variant={p.idp === "google" ? "primary" : "outline"}
              size="lg"
              className="w-full"
              onClick={() => signIn(p.providerId, { callbackURL })}
            >
              {p.idp === "google" ? <GoogleMark /> : <XMark />}
              Continue with {p.label}
            </Button>
          ))
        ) : (
          <p className="text-sm text-muted">Sign-in is disabled.</p>
        )}
      </div>

      <p className="mt-8 text-sm text-subtle">
        After connect: pick a voice, listen to Rift, drop a reaction. That clears the gate.
      </p>
      <Link to="/connect" className="mt-2 text-sm text-fg underline underline-offset-4">
        See the 60-second path
      </Link>
    </main>
  );
}

function safeNext(next: string | undefined) {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.6 12.23c0-.74-.06-1.28-.19-1.84H12v3.34h5.48c-.11.9-.71 2.26-2.05 3.18l-.02.1 2.98 2.26.2.02c1.9-1.72 3-4.25 3-7.06z"
      />
      <path
        fill="currentColor"
        d="M12 22c2.7 0 4.96-.87 6.62-2.37l-3.16-2.4c-.85.58-1.99 1-3.46 1-2.64 0-4.88-1.74-5.68-4.15l-.1.01-3.09 2.34-.04.09C4.77 19.89 8.13 22 12 22z"
      />
      <path
        fill="currentColor"
        d="M6.32 13.08A5.8 5.8 0 0 1 6 12c0-.38.04-.75.1-1.08l-.01-.11-3.13-2.38-.1.05A9.98 9.98 0 0 0 2 12c0 1.62.4 3.15 1.1 4.52l3.22-3.44z"
      />
      <path
        fill="currentColor"
        d="M12 6.58c1.88 0 3.15.8 3.87 1.46l2.83-2.7C16.95 3.89 14.7 3 12 3 8.13 3 4.77 5.11 3.1 8.48l3.22 2.44C7.12 8.5 9.36 6.58 12 6.58z"
      />
    </svg>
  );
}

function XMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M17.5 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.7 21H2.6l7.3-8.3L2 3h6.3l4.4 5.7L17.5 3zm-1.1 16.2h1.7L7.7 4.7H5.9l10.5 14.5z"
      />
    </svg>
  );
}
