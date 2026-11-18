"use client";

import type { ReactNode } from "react";

export function Modal({
  children,
  title,
  subtitle,
  onClose,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-[#02050a]/80 p-4 backdrop-blur-md" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-labelledby="modal-title" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0a111b] shadow-[0_28px_100px_rgba(0,0,0,.65)]" role="dialog">
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100" id="modal-title">{title}</h2>
            {subtitle ? <p className="mt-1 text-xs text-slate-500">{subtitle}</p> : null}
          </div>
          <button aria-label="Close dialog" className="icon-button" onClick={onClose} type="button">×</button>
        </header>
        <div className="p-5">{children}</div>
      </section>
    </div>
  );
}
