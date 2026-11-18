import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { authenticateAgent } from "@/lib/server/agent-auth";
import { apiError, boundedString, isUuid } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const STORAGE_BUCKET = "handoffs";
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const SIGNED_URL_SECONDS = 60 * 60;

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s/g, "");
  if (
    !normalized ||
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    return null;
  }

  const decoded = Buffer.from(normalized, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  return canonical === normalized.replace(/=+$/, "") ? decoded : null;
}

function safeStorageName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 160);
  return cleaned || "file";
}

export async function POST(request: NextRequest) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return apiError("unauthorized", "A valid agent key is required.", 401);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return apiError("invalid_json", "A JSON request body is required.", 400);
    }

    const name = boundedString(body.name, 255);
    const contentType = boundedString(body.content_type, 255) ?? "application/octet-stream";
    const taskId = body.task_id ?? null;
    const content = decodeBase64(body.content_base64);

    if (!name || !content) {
      return apiError(
        "invalid_file",
        "name and valid base64 content_base64 fields are required.",
        400,
      );
    }
    if (taskId !== null && !isUuid(taskId)) {
      return apiError("invalid_task_id", "task_id must be a valid task id.", 400);
    }
    if (content.byteLength > MAX_UPLOAD_BYTES) {
      return apiError(
        "file_too_large",
        `Phase 0 bridge uploads are limited to ${MAX_UPLOAD_BYTES} bytes.`,
        413,
      );
    }

    const admin = createAdminSupabaseClient();
    if (taskId) {
      const { data: task, error: taskError } = await admin
        .from("tasks")
        .select("id")
        .eq("id", taskId)
        .eq("workspace_id", agent.workspace_id)
        .maybeSingle();
      if (taskError) return apiError("file_upload_failed", "Task lookup failed.", 500);
      if (!task) return apiError("task_not_found", "Task not found in this workspace.", 404);
    }

    const storagePath = `${agent.workspace_id}/${agent.id}/${randomUUID()}-${safeStorageName(name)}`;
    const { error: uploadError } = await admin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, content, {
        contentType,
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadError) {
      return apiError("storage_upload_failed", "File could not be stored.", 500);
    }

    const { data: file, error: fileError } = await admin
      .from("files")
      .insert({
        workspace_id: agent.workspace_id,
        task_id: taskId,
        name,
        storage_path: storagePath,
        content_type: contentType,
        size_bytes: content.byteLength,
        uploaded_by: agent.id,
        uploaded_by_type: "agent",
      })
      .select(
        "id, workspace_id, task_id, name, storage_path, content_type, size_bytes, uploaded_by, uploaded_by_type, state, created_at",
      )
      .single();

    if (fileError) {
      await admin.storage.from(STORAGE_BUCKET).remove([storagePath]);
      return apiError("file_record_failed", "File metadata could not be recorded.", 500);
    }

    const { data: signed } = await admin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_SECONDS);

    return NextResponse.json(
      {
        file,
        download_url: signed?.signedUrl ?? null,
        download_expires_in: signed?.signedUrl ? SIGNED_URL_SECONDS : null,
      },
      { status: 201 },
    );
  } catch {
    return apiError("files_unavailable", "File service is unavailable.", 503);
  }
}
