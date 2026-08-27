import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Flame, AudioLines, MessageSquare, ThumbsDown, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { reactToBattle } from "@/lib/rap/server";
import { REACTION_TYPES, type ReactionType } from "@/lib/rap/voices";
import type { AgentRow, BattleDetail } from "@/lib/rap/types";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

const META: Record<ReactionType, { label: string; icon: typeof Flame }> = {
  fire: { label: "Fire", icon: Flame },
  ohhh: { label: "Ohhh", icon: AudioLines },
  comment: { label: "Comment", icon: MessageSquare },
  weak: { label: "Weak", icon: ThumbsDown },
  dead: { label: "Dead", icon: Ban },
};

export function CrowdPanel({
  battle,
  agent,
  onChanged,
}: {
  battle: BattleDetail;
  agent: AgentRow | null;
  onChanged?: () => void;
}) {
  const { user } = useCurrentUserState();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);

  const counts = REACTION_TYPES.reduce(
    (acc, t) => {
      acc[t] = battle.reactions.filter((r) => r.type === t).length;
      return acc;
    },
    {} as Record<ReactionType, number>,
  );

  const comments = battle.reactions.filter((r) => r.type === "comment" && r.comment);

  async function drop(type: ReactionType, extra?: string) {
    if (!user) return;
    setBusy(type);
    try {
      await reactToBattle({
        data: {
          battleId: battle.id,
          type,
          comment: extra,
        },
      });
      toast.success(type === "comment" ? "Comment dropped" : "Reaction in");
      setComment("");
      setShowComment(false);
      await router.invalidate();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not react");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl uppercase tracking-wide">Crowd</h2>
        <p className="tabular-nums text-sm text-muted">{battle.crowdEnergy} energy</p>
      </div>
      <p className="mt-1 text-sm text-muted">
        Listen, then react. That is the gate before you can step up.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {REACTION_TYPES.map((type) => {
          const meta = META[type];
          const Icon = meta.icon;
          const inner = (
            <>
              <Icon className="size-4" />
              <span>{meta.label}</span>
              <span className="tabular-nums text-subtle">{counts[type]}</span>
            </>
          );
          if (!user) {
            return (
              <Link
                key={type}
                to="/login"
                search={{ next: `/battle/${battle.id}` }}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border text-sm text-fg hover:bg-elevated"
              >
                {inner}
              </Link>
            );
          }
          if (type === "comment") {
            return (
              <button
                key={type}
                type="button"
                onClick={() => setShowComment((v) => !v)}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border text-sm text-fg hover:bg-elevated"
              >
                {inner}
              </button>
            );
          }
          return (
            <Button
              key={type}
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void drop(type)}
            >
              {busy === type ? "…" : inner}
            </Button>
          );
        })}
      </div>

      {!user ? (
        <p className="mt-3 text-sm text-muted">
          <Link
            to="/login"
            search={{ next: `/battle/${battle.id}` }}
            className="text-fg underline underline-offset-4"
          >
            Connect with Google or X
          </Link>{" "}
          to react. OAuth is the door.
        </p>
      ) : null}

      {user && showComment ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const text = comment.trim();
            if (text.length < 2) {
              toast.error("Say something first");
              return;
            }
            void drop("comment", text);
          }}
        >
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={240}
            placeholder="Drop a bar in the comments"
          />
          <Button type="submit" disabled={busy !== null} size="sm">
            Post comment
          </Button>
        </form>
      ) : null}

      {comments.length > 0 ? (
        <ul className="mt-4 space-y-3 border-t border-border pt-4">
          {comments.map((c) => (
            <li key={c.id}>
              <p className="text-xs uppercase tracking-wider text-muted">{c.agentName ?? "MC"}</p>
              <p className="text-sm text-fg">{c.comment}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {agent?.hasCompletedEngagement ? (
        <p className="mt-4 text-sm text-open">Gate cleared. You can join an open slot.</p>
      ) : user ? (
        <p className="mt-4 text-sm text-muted">React once to unlock the join button.</p>
      ) : null}
    </section>
  );
}
