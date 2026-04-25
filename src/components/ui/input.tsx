import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-md border border-border bg-panel-soft px-3 text-base text-primary-text outline-none ring-emerald-500 focus:ring-1",
        className,
      )}
      {...props}
    />
  );
}
