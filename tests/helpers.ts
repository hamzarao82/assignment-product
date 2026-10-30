import { type Task, toTaskId } from "../src/types";

/** Builds a valid Task; updatedAt defaults to createdAt so the two never disagree by accident. */
export function makeTask(id: string, over: Partial<Omit<Task, "id">> = {}): Task {
  const createdAt = over.createdAt ?? new Date("2024-01-01T00:00:00.000Z");
  return {
    id: toTaskId(id),
    title: `Task ${id}`,
    priority: "medium",
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    dueAt: null,
    tags: [],
    version: 0,
    ...over,
  };
}
