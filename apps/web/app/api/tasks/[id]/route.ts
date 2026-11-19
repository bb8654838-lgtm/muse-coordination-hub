import { taskApiResponse, updateTask } from "@/lib/server/task-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return taskApiResponse(() => updateTask(request, id));
}
