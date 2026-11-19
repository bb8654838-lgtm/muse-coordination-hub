"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

const focusableSelector = "button:not([disabled]), a[href], input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function Modal({
  children,
  title,
  subtitle,
  description,
  onClose,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  description?: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const detail = subtitle ?? description;

  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
    const firstInput = focusable().find(element => element.matches("input, textarea, select"));
    (firstInput ?? focusable()[0] ?? dialog).focus({ preventScroll: true });
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0], last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); dialog!.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || !dialog!.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog!.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="modal-overlay fixed inset-0 z-[90] bg-[#02050a]/80 backdrop-blur-md" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-labelledby={titleId} aria-describedby={detail ? descriptionId : undefined} aria-modal="true" className="modal-surface min-w-0 w-full rounded-2xl border border-white/10 bg-[#0a111b] shadow-[0_28px_100px_rgba(0,0,0,.65)]" role="dialog" tabIndex={-1} ref={dialogRef}>
        <header className="modal-header flex min-w-0 items-start justify-between gap-3 border-b border-white/[0.08] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-100" id={titleId}>{title}</h2>
            {detail ? <p className="mt-1 text-xs text-slate-500" id={descriptionId}>{detail}</p> : null}
          </div>
          <button aria-label="Close dialog" className="icon-button shrink-0" onClick={onClose} type="button">×</button>
        </header>
        <div className="modal-body min-w-0 p-5">{children}</div>
      </section>
    </div>
  );
}
