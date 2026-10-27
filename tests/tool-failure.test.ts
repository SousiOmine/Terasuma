import { describe, expect, test } from "bun:test";
import { NoSuchToolError } from "ai";
import { z } from "zod";
import { describeToolFailure } from "../src/server/agent/tool-failure";

/** ツールの失敗を、モデルが直せる短い文にすること。 */

const ROUTINE_SCHEMA = z.object({
  name: z.string(),
  schedule: z.object({ time: z.string() }),
  note: z.number(),
  place: z.string(),
});

describe("ツールの失敗の文面", () => {
  test("Zod の issues を、パス付きで先頭 3 件まで並べる", () => {
    const parsed = ROUTINE_SCHEMA.safeParse({
      name: 123,
      schedule: { time: 9 },
      note: "no",
      place: true,
    });
    if (parsed.success) throw new Error("検証が失敗しませんでした");

    const text = describeToolFailure("routine_create", parsed.error);

    expect(text.startsWith('Invalid arguments for "routine_create": ')).toBe(true);
    expect(text).toContain("name:");
    expect(text).toContain("schedule.time:");
    expect(text).toContain("note:");
    expect(text).not.toContain("place:");
    expect(text).toContain('Call tool_search("routine_create")');
    expect(text.split(";")).toHaveLength(3);
  });

  test("AI SDK の長い検証エラーから、短い文を作る", () => {
    const error = new Error(
      'AI_InvalidToolInputError: Invalid input for tool skill: AI_TypeValidationError: Type validation failed: Value: {"name":123}.\nError message: [ { "expected": "string", "code": "invalid_type", "path": ["name"] } ]',
    );

    const text = describeToolFailure("skill", error);

    expect(text.startsWith('Invalid arguments for "skill": ')).toBe(true);
    expect(text.length).toBeLessThan(200);
    expect(text).not.toContain("Error message:");
    expect(text).not.toContain("expected");
    expect(text).toContain('Call tool_search("skill")');
  });

  test("既に短い文になっている失敗は、前置きを重ねない", () => {
    const short =
      'Invalid arguments for "routine_create": name: Invalid input: expected string, received number. Call tool_search("routine_create") to see the arguments, then call tool_call again.';

    expect(describeToolFailure("routine_create", new Error(short))).toBe(short);
  });

  test("ツールが無いときは、検索してから呼ぶよう伝える", () => {
    const text = describeToolFailure("no_such_tool", new NoSuchToolError({ toolName: "no_such_tool" }));

    expect(text).toBe('No tool named "no_such_tool". Use tool_search to find the name, then call it with tool_call.');
  });

  test("その他の例外は、最初の行だけを使う", () => {
    const text = describeToolFailure("bash", new Error("command failed\nstack trace here"));

    expect(text).toBe("command failed");
  });

  test("Error: の接頭辞も落とす", () => {
    const text = describeToolFailure("bash", new Error("Error: command failed"));

    expect(text).toBe("command failed");
  });

  test("長い message は 300 文字に切り詰める", () => {
    const text = describeToolFailure("tool", new Error(`Type validation failed: ${"a".repeat(400)}`));

    expect(text.length).toBe(300);
  });
});
