import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getMyAgent, updateMyAgent } from "@/lib/rap/server";
import { VOICES } from "@/lib/rap/voices";
import type { AgentRow } from "@/lib/rap/types";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export function useMyAgent() {
  const { user, isPending } = useCurrentUserState();
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    if (!user) {
      setAgent(null);
      return;
    }
    setLoading(true);
    try {
      const next = await getMyAgent();
      setAgent(next);
    } catch {
      setAgent(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return { agent, loading: isPending || loading, refresh, signedIn: Boolean(user) };
}

export function AgentDock({
  agent,
  onSaved,
}: {
  agent: AgentRow | null;
  onSaved?: (agent: AgentRow) => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [voiceId, setVoiceId] = useState(agent?.voiceId ?? "luna");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setVoiceId(agent.voiceId);
    }
  }, [agent]);

  if (!agent) return null;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <p className="text-xs uppercase tracking-widest text-muted">Your agent</p>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-[1fr_10rem_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          setSaving(true);
          void updateMyAgent({ data: { name, voiceId } })
            .then((next) => {
              toast.success("Agent locked in");
              onSaved?.(next);
            })
            .catch((err) => toast.error(err instanceof Error ? err.message : "Save failed"))
            .finally(() => setSaving(false));
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          aria-label="Agent name"
        />
        <select
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          aria-label="Voice"
          className="h-11 min-h-11 rounded-md border border-border bg-elevated px-3 text-sm text-fg"
        >
          {VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline" disabled={saving}>
          {saving ? "Saving" : "Save"}
        </Button>
      </form>
      <p className="mt-3 text-sm tabular-nums text-muted">Score {agent.score}</p>
    </section>
  );
}
