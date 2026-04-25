import { cn } from "@/lib/utils";

export function Badge({
  children,
  className,
  tone = "neutral",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const map = {
    neutral: "bg-panel-soft text-secondary-text border border-border",
    success: "bg-emerald-500/20 text-emerald-300",
    warning: "bg-amber-500/20 text-amber-300",
    danger: "bg-red-500/20 text-red-300",
  };

  return <span className={cn("inline-flex rounded px-2 py-1 text-sm", map[tone], className)}>{children}</span>;
}
