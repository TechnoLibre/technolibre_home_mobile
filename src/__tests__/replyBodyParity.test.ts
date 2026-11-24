import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { EMPTY_MENTIONS, composeBody } from "../services/chat/chatCompose";

interface Case { name: string; text: string; body: string }

// The Java ReplyBody (android, JVM test ReplyBodyTest) is held to this file: it must be what composeBody writes.
const FIXTURE = resolve(__dirname, "../../android/app/src/test/resources/chatpush/reply_body_parity.json");

describe("the reply body parity fixture of the native side", () => {
  const cases = JSON.parse(readFileSync(FIXTURE, "utf8")) as Case[];

  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(50);
  });

  for (const c of cases) {
    it(`${c.name} is what composeBody writes`, () => {
      expect(composeBody(c.text, EMPTY_MENTIONS, []).body).toBe(c.body);
    });
  }
});
