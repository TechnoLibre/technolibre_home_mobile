import { beforeAll, describe, expect, it } from "vitest";

import { EMPTY_MENTIONS, Mentions, composeBody, linkify, validMentions } from "../services/chat/chatCompose";
import { EmojiConversion, emojiConversions } from "../services/chat/chatEmoji";
import cases from "./fixtures/composer-cases.json";
import goldens from "./fixtures/composer-golden.json";

interface Case { name: string; text: string; mentions?: Mentions }
interface Golden { name: string; body: string; partnerIds: number[]; specialMentions: string[] }

let conversions: EmojiConversion[] = [];

beforeAll(async () => {
  conversions = await emojiConversions();
});

const alice = { id: 7, name: "Alice Martin" };
const channel = { id: 3, name: "général-test", parentName: null };
const thread = { id: 4, name: "sous-fil", parentName: "général-test" };

describe("composeBody matches every golden", () => {
  it("has one golden per case, in the same order", () => {
    expect((goldens as Golden[]).map((g) => g.name)).toEqual((cases as Case[]).map((c) => c.name));
  });

  for (const [i, c] of (cases as Case[]).entries()) {
    it(c.name, () => {
      const golden = (goldens as Golden[])[i];
      expect(composeBody(c.text, c.mentions ?? EMPTY_MENTIONS, conversions)).toEqual({
        body: golden.body,
        partnerIds: golden.partnerIds,
        specialMentions: golden.specialMentions,
      });
    });
  }
});

describe("validMentions", () => {
  it("drops a pick whose text was edited away", () => {
    const picks: Mentions = { partners: [alice], channels: [channel, thread] };
    // The sub-channel's text holds its parent's too: both stay, as in the browser
    expect(validMentions("@Alice Martin dans #général-test > sous-fil", picks)).toEqual({
      partners: [alice], channels: [channel, thread], special: [],
    });
    expect(validMentions("@Alice Martin dans #général-test", picks)).toEqual({
      partners: [alice], channels: [channel], special: [],
    });
    expect(validMentions("@Alice Mart dans #général", picks)).toEqual({ partners: [], channels: [], special: [] });
  });

  it("finds @everyone in the text alone", () => {
    expect(validMentions("à @everyone", EMPTY_MENTIONS).special).toEqual(["everyone"]);
  });
});

describe("partnerIds and specialMentions", () => {
  it("lists the kept partners in pick order and everyone", () => {
    const bob = { id: 9, name: "Bob" };
    const out = composeBody("@Bob, @everyone", { partners: [alice, bob], channels: [] }, conversions);
    expect(out.partnerIds).toEqual([9]);
    expect(out.specialMentions).toEqual(["everyone"]);
  });
});

describe("linkify", () => {
  it("escapes the text around a link and keeps the typed URL as its text", () => {
    expect(linkify("a 'b' www.example.org.")).toBe(
      'a &#x27;b&#x27; <a target="_blank" rel="noreferrer noopener" href="http://www.example.org/">www.example.org</a>.',
    );
    expect(linkify("https://x <")).toBe("https://x &lt;");
  });
});
