"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { VisualTransferEvent } from "@/lib/realtime-visual-events";

export const MAX_ACTIVE_TRANSFERS = 12;

type TimedTransfer = VisualTransferEvent & { expiresAt: number };
type TransferState = { active: TimedTransfer[]; pending: VisualTransferEvent[] };

function activate(events: VisualTransferEvent[], now: number): TimedTransfer[] {
  return events.map((event) => ({ ...event, expiresAt: now + event.durationMs }));
}

export function useTransferQueue() {
  const seenIds = useRef(new Set<string>());
  const [queue, setQueue] = useState<TransferState>({ active: [], pending: [] });

  const enqueue = useCallback((event: VisualTransferEvent | null) => {
    if (!event || seenIds.current.has(event.id)) return;
    seenIds.current.add(event.id);
    if (seenIds.current.size > 600) {
      const oldest = seenIds.current.values().next().value;
      if (oldest) seenIds.current.delete(oldest);
    }

    setQueue((current) => {
      const now = Date.now();
      const live = current.active.filter((item) => item.expiresAt > now);
      const pending = [...current.pending, event];
      const slots = Math.max(0, MAX_ACTIVE_TRANSFERS - live.length);
      const promoted = pending.splice(0, slots);
      return { active: [...live, ...activate(promoted, now)], pending };
    });
  }, []);

  useEffect(() => {
    if (!queue.active.length) return;
    const nextExpiry = Math.min(...queue.active.map((item) => item.expiresAt));
    const timer = window.setTimeout(() => {
      setQueue((current) => {
        const now = Date.now();
        const live = current.active.filter((item) => item.expiresAt > now);
        const pending = [...current.pending];
        const slots = Math.max(0, MAX_ACTIVE_TRANSFERS - live.length);
        const promoted = pending.splice(0, slots);
        return { active: [...live, ...activate(promoted, now)], pending };
      });
    }, Math.max(16, nextExpiry - Date.now() + 12));
    return () => window.clearTimeout(timer);
  }, [queue]);

  const clearTransfers = useCallback(() => {
    setQueue({ active: [], pending: [] });
  }, []);

  return {
    transfers: queue.active as VisualTransferEvent[],
    queuedCount: queue.pending.length,
    enqueue,
    clearTransfers,
  };
}
