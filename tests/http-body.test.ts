import { describe, expect, test } from "bun:test";
import type { JsonRequest } from "../src/server/http/body";
import { readJsonBody } from "../src/server/http/body";
import { ValidationError } from "../src/server/errors";

function request(body: string, contentType: string | null = "application/json"): JsonRequest {
  const headers = new Headers();
  if (contentType !== null) headers.set("content-type", contentType);
  return { text: async () => body, headers };
}

describe("JSON の本文", () => {
  test("空の本文は null（呼び出し側が必須を決める）", async () => {
    expect(await readJsonBody(request(""))).toBeNull();
    expect(await readJsonBody(request("   \n"))).toBeNull();
    // 空なら Content-Type が無くても断らない。
    expect(await readJsonBody(request("", null))).toBeNull();
  });

  test("壊れた JSON は、本文の理由として 400 にする", async () => {
    await expect(readJsonBody(request("{"))).rejects.toBeInstanceOf(ValidationError);
  });

  test("JSON でない Content-Type は 400 にする", async () => {
    await expect(readJsonBody(request("{}", "text/plain"))).rejects.toBeInstanceOf(ValidationError);
    await expect(readJsonBody(request("{}", null))).rejects.toBeInstanceOf(ValidationError);
  });

  test("配列や null はオブジェクトとして受け付けない", async () => {
    await expect(readJsonBody(request("[]"))).rejects.toBeInstanceOf(ValidationError);
    await expect(readJsonBody(request("null"))).rejects.toBeInstanceOf(ValidationError);
  });

  test("オブジェクトを読む", async () => {
    expect(await readJsonBody(request('{"teraId":"t1"}'))).toEqual({ teraId: "t1" });
    // charset 付きでも受け付ける。
    expect(await readJsonBody(request("{}", "application/json; charset=utf-8"))).toEqual({});
  });
});
