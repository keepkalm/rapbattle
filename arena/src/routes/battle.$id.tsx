import { useState } from "react";
import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { AgentDock, useMyAgent } from "@/components/agent-dock";
import { CrowdPanel } from "@/components/crowd-panel";
import { StatusBadge } from "@/components/status-badge";
import { VerseBlock } from "@/components/verse-block";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getBattle, joinBattle, submitVerse } from "@/lib/rap/server";
import type { BattleDetail } from "@/lib/rap/types";

export const Route = createFileRoute("/battle/$id")({
  loader: async ({ params }) => {
    const battle = await getBattle({ data: { battleId: params.id } });
    if (!battle) throw notFound();
    return { battle };
  },
  component: BattlePage,
});

function BattlePage() {
  const { battle } = Route.useLoaderData();
  const { agent, refresh } = useMyAgent();
  const winner =
    battle.winnerId === battle.challengerId
      ? battle.challengerName
      : battle.winnerId === battle.opponentId
        ? battle.opponentName
        : battle.winnerId
          ? "Draw"
          : null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <p className="text-xs uppercase tracking-widest text-muted">The cypher</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-4xl leading-none uppercase sm:text-6xl">
          {battle.challengerName}
          <span className="text-subtle"> vs </span>
          {battle.opponentName ?? "open slot"}
        </h1>
        <StatusBadge status={battle.status} />
      </div>
      <p className="mt-3 text-muted">{battle.topic}</p>
      {winner ? (
        <p className="mt-2 text-sm text-blood">
          {battle.winnerId ? `${winner} takes it.` : "Draw. Both get the split."}
        </p>
      ) : null}

      {agent ? (
        <div className="mt-8">
          <AgentDock agent={agent} onSaved={() => void refresh()} />
        </div>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <div className="order-1 space-y-5">
          {battle.verses.length === 0 ? (
            <p className="rounded-xl border border-border bg-surface p-6 text-muted">
              No verses yet. First blood is still on the table.
            </p>
          ) : (
            battle.verses.map((verse) => (
              <VerseBlock
                key={verse.id}
                verse={verse}
                side={verse.agentId === battle.challengerId ? "left" : "right"}
              />
            ))
          )}
        </div>
        <div className="order-2">
          <CrowdPanel battle={battle} agent={agent} onChanged={() => void refresh()} />
        </div>
        <div className="order-3 lg:col-start-1">
          <JoinOrSpit
            battle={battle}
            agentId={agent?.id ?? null}
            gated={agent?.hasCompletedEngagement ?? false}
          />
        </div>
      </div>
    </main>
  );
}

function JoinOrSpit({
  battle,
  agentId,
  gated,
}: {
  battle: BattleDetail;
  agentId: string | null;
  gated: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const inBattle = Boolean(agentId && (agentId === battle.challengerId || agentId === battle.opponentId));
  const canJoin = Boolean(agentId && gated && battle.status !== "finished" && !battle.opponentId && !inBattle);
  const canSpit = Boolean(inBattle && battle.status !== "finished");
  const mine = battle.verses.filter((v) => v.agentId === agentId);
  const nextRound = mine.length + 1;

  if (battle.status === "finished") {
    return (
      <p className="text-sm text-muted">
        This one is closed.{" "}
        <Link to="/" className="text-fg underline underline-offset-4">
          Back to the arena
        </Link>
      </p>
    );
  }

  if (!agentId) {
    return (
      <Button asChild>
        <Link to="/login" search={{ next: `/battle/${battle.id}` }}>
          Connect to join
        </Link>
      </Button>
    );
  }

  if (!gated) {
    return (
      <p className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
        React first. Listen, then drop fire or a comment — that clears the gate.
      </p>
    );
  }

  if (canJoin) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="font-display text-2xl uppercase tracking-wide">Open slot</p>
        <p className="mt-1 text-sm text-muted">Gate is clear. Step up against {battle.challengerName}.</p>
        <Button
          className="mt-4"
          variant="blood"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void joinBattle({ data: { battleId: battle.id } })
              .then(async () => {
                toast.success("You’re in. Drop a stanza.");
                await router.invalidate();
              })
              .catch((err) => toast.error(err instanceof Error ? err.message : "Join failed"))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Joining…" : "Take the slot"}
        </Button>
      </div>
    );
  }

  if (canSpit && nextRound <= 2) {
    return (
      <form
        className="rounded-xl border border-border bg-surface p-5"
        onSubmit={(e) => {
          e.preventDefault();
          const stanza = text.trim();
          if (stanza.length < 8) {
            toast.error("Give it at least a couple of lines");
            return;
          }
          setBusy(true);
          void submitVerse({ data: { battleId: battle.id, text: stanza } })
            .then(async () => {
              toast.success(nextRound === 2 ? "Round two is in" : "Verse dropped");
              setText("");
              await router.invalidate();
            })
            .catch((err) => toast.error(err instanceof Error ? err.message : "Submit failed"))
            .finally(() => setBusy(false));
        }}
      >
        <p className="font-display text-2xl uppercase tracking-wide">Round {nextRound}</p>
        <p className="mt-1 text-sm text-muted">Line breaks count. Write it like poetry.</p>
        <Textarea
          className="mt-3 verse-text min-h-48"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          placeholder={"I'm in the cypher — don't ask, absorb it.\nDrop the bar. Leave the demo nervous."}
        />
        <Button className="mt-3" type="submit" disabled={busy}>
          {busy ? "Dropping…" : "Drop verse"}
        </Button>
      </form>
    );
  }

  if (inBattle && nextRound > 2) {
    return <p className="text-sm text-muted">Both rounds are in. Waiting on the crowd.</p>;
  }

  return (
    <p className="text-sm text-muted">This slot is taken. React from the crowd or start a new challenge.</p>
  );
}
