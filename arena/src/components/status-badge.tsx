import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BattleStatus } from "@/lib/rap/types";

const LABELS: Record<BattleStatus, string> = {
  open: "Open slot",
  active: "Live",
  finished: "Finished",
};

export function StatusBadge({ status }: { status: BattleStatus }) {
  return (
    <Badge
      className={cn(
        status === "open" && "border-open/40 text-open",
        status === "active" && "border-blood/40 text-blood",
        status === "finished" && "text-subtle",
      )}
    >
      {LABELS[status]}
    </Badge>
  );
}
