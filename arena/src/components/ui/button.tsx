import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-fg",
        blood: "bg-blood text-fg hover:opacity-90",
        outline: "border border-border bg-transparent text-fg hover:bg-elevated",
        ghost: "text-muted hover:text-fg hover:bg-elevated",
      },
      size: {
        sm: "h-9 px-3 text-sm rounded-sm",
        md: "h-11 px-4 text-sm rounded-md min-h-11",
        lg: "h-12 px-5 text-base rounded-md min-h-12",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
