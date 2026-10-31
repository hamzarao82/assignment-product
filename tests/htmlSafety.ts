import { expect } from "vitest";

/** Attribute names the renderer is allowed to emit. Anything else is an injection. */
export const ALLOWED_ATTRIBUTES = new Set([
  "class",
  "id",
  "role",
  "href",
  "type",
  "datetime",
  "aria-labelledby",
  "aria-live",
  "aria-atomic",
  "aria-busy",
  "aria-label",
  "aria-hidden",
  "data-action",
  "data-task-id",
  "data-choice",
]);

export interface Tag {
  name: string;
  attrs: Record<string, string>;
}

/** Tokenises our (always double-quoted) markup so tests inspect real tags and attributes. */
export function tokenize(html: string): { tags: Tag[]; strayAngles: number } {
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>"'/]+(?:="[^"]*")?)*)\s*\/?>/g;
  const tags: Tag[] = [];
  let matched = 0;
  for (const match of html.matchAll(tagPattern)) {
    matched++;
    if (match[0].startsWith("</")) continue; // closing tags count as tags but carry no attributes
    const attrs: Record<string, string> = {};
    for (const a of (match[2] ?? "").matchAll(/\s+([^\s=>"'/]+)(?:="([^"]*)")?/g)) {
      attrs[a[1] ?? ""] = a[2] ?? "";
    }
    tags.push({ name: match[1] ?? "", attrs });
  }
  const strayAngles = (html.match(/</g) ?? []).length - matched;
  return { tags, strayAngles };
}

export function expectSafeMarkup(html: string): void {
  const { tags, strayAngles } = tokenize(html);
  expect(strayAngles).toBe(0); // every "<" in the output opens a real tag we generated
  expect(html).not.toContain("<script");
  for (const tag of tags) {
    for (const name of Object.keys(tag.attrs)) {
      expect(ALLOWED_ATTRIBUTES.has(name)).toBe(true);
      expect(name.startsWith("on")).toBe(false);
    }
  }
}
