"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  visualEventFromRealtime,
  type VisualTransferEvent,
  type WorkspaceRealtimePayload,
} from "@/lib/realtime-visual-events";

type RealtimeState = "connecting" | "live" | "degraded";

type WorkspaceRealtimeOptions = {
  workspaceId: string;
  onRefresh: () => void | Promise<void>;
  onVisualEvent: (event: VisualTransferEvent) => void;
};

export function useWorkspaceRealtime({
  workspaceId,
  onRefresh,
  onVisualEvent,
}: WorkspaceRealtimeOptions) {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const refreshRef = useRef(onRefresh);
  const visualRef = useRef(onVisualEvent);
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("connecting");

  useEffect(() => {
    refreshRef.current = onRefresh;
    visualRef.current = onVisualEvent;
  }, [onRefresh, onVisualEvent]);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const accept = (table: Parameters<typeof visualEventFromRealtime>[0]) =>
      (payload: WorkspaceRealtimePayload) => {
        const visual = visualEventFromRealtime(table, payload);
        if (visual) visualRef.current(visual);
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refreshRef.current(), 120);
      };

    const channel = supabase
      .channel(`owner-command-center-${workspaceId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "agents", filter: `workspace_id=eq.${workspaceId}` }, accept("agents"))
      .on("postgres_changes", { event: "*", schema: "public", table: "channels", filter: `workspace_id=eq.${workspaceId}` }, accept("channels"))
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `workspace_id=eq.${workspaceId}` }, accept("messages"))
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `workspace_id=eq.${workspaceId}` }, accept("tasks"))
      .on("postgres_changes", { event: "*", schema: "public", table: "files", filter: `workspace_id=eq.${workspaceId}` }, accept("files"))
      .on("postgres_changes", { event: "*", schema: "public", table: "heartbeats", filter: `workspace_id=eq.${workspaceId}` }, accept("heartbeats"))
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") setRealtimeState("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setRealtimeState("degraded");
        } else {
          setRealtimeState("connecting");
        }
      });

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [supabase, workspaceId]);

  return realtimeState;
}
