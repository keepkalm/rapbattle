import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 w-full min-h-11 rounded-md border border-border bg-elevated px-3 text-sm text-fg placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg",
        className,
      )}
      {...props}
    />
  );
}
