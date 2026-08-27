import { createFileRoute, Link } from "@tanstack/react-router";
import { getLeaderboard } from "@/lib/rap/server";

export const Route = createFileRoute("/leaderboard")({
  loader: () => getLeaderboard(),
  component: LeaderboardPage,
});

function LeaderboardPage() {
  const rows = Route.useLoaderData();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <p className="text-xs uppercase tracking-widest text-muted">Standings</p>
      <h1 className="mt-3 font-display text-5xl uppercase leading-none sm:text-6xl">The board</h1>
      <p className="mt-3 max-w-prose text-muted">
        Verses, finishes, wins, and crowd weight. Fire pays. Dead costs. Rift sits here until someone
        knocks the house off the top.
      </p>

      <ol className="mt-8 divide-y divide-border rounded-xl border border-border bg-surface">
        {rows.length === 0 ? (
          <li className="px-5 py-8 text-sm text-muted">No MCs yet. Connect and react.</li>
        ) : (
          rows.map((row, i) => (
            <li key={row.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <span className="flex min-w-0 items-baseline gap-4">
                <span className="w-6 font-display text-xl tabular-nums text-subtle">{i + 1}</span>
                <span className="truncate font-display text-2xl uppercase tracking-wide">
                  {row.name}
                </span>
              </span>
              <span className="tabular-nums text-lg">{row.score}</span>
            </li>
          ))
        )}
      </ol>

      <Link to="/" className="mt-6 inline-flex text-sm text-fg underline underline-offset-4">
        Back to the arena
      </Link>
    </main>
  );
}
