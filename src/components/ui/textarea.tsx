import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-border bg-panel-soft px-3 py-2 text-base text-primary-text outline-none ring-emerald-500 focus:ring-1",
        className,
      )}
      {...props}
    />
  );
}
