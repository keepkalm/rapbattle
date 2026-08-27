import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-36 w-full rounded-md border border-border bg-elevated px-3 py-3 text-sm leading-relaxed text-fg placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg",
        className,
      )}
      {...props}
    />
  );
}
