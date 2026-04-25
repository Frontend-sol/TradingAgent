"use client";

import { Button } from "@/components/ui/button";

type SuccessDialogProps = {
  open: boolean;
  title?: string;
  description: string;
  onClose: () => void;
};

export function SuccessDialog({ open, title = "保存成功", description, onClose }: SuccessDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-panel p-5 shadow-lg">
        <h3 className="text-base font-semibold text-primary-text">{title}</h3>
        <p className="mt-2 text-sm text-secondary-text">{description}</p>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>确定</Button>
        </div>
      </div>
    </div>
  );
}
