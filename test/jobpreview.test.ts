import { expect, test } from "bun:test";
import { jobPreview } from "../src/queue.ts";

test("job preview: first 6 words; a message with only an attachment says so", () => {
  expect(jobPreview("fix   the\nboard now")).toBe("fix the board now");
  expect(jobPreview("one two three four five six seven")).toBe("one two three four five six…");
  expect(jobPreview("")).toBe("attachment");
  expect(jobPreview("  \n ")).toBe("attachment");
});
