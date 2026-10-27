import { type Task, toTaskId } from "../src/types";

export function makeTask(id: string, over: Partial<Omit<Task, "id">> = {}): Task {
  return {
    id: toTaskId(id),
    title: `Task ${id}`,
    priority: "medium",
    completedAt: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    tags: [],
    ...over,
  };
}
