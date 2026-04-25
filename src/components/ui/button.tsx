import * as React from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "secondary" | "outline" | "danger";

const variants: Record<ButtonVariant, string> = {
  default: "bg-emerald-500 hover:bg-emerald-400 text-black",
  secondary: "bg-panel-soft hover:brightness-95 text-primary-text border border-border",
  outline: "border border-border hover:brightness-95 bg-panel text-primary-text",
  danger: "bg-red-500 hover:bg-red-400 text-white",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ className, variant = "default", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md px-3 py-2 text-base font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
