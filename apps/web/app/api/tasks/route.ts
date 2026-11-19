import { createTask, listTasks, taskApiResponse } from "@/lib/server/task-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return taskApiResponse(() => listTasks(request));
}

export async function POST(request: Request) {
  return taskApiResponse(() => createTask(request), 201);
}
