import { describe, it, expect } from "vitest";
import { parseNtfyLink } from "../services/chat/chatPushLink";

/** The invented link every test of both sides uses (R4). */
const LINK = "erplibre-ntfy:setup?v=1&url=http%3A%2F%2Fntfy.exemple.test%3A8080&token=tk_exempleexempleexempleexemple"
  + "&prefix=upab12cd34&cache=43200&odoo=http%3A%2F%2Fodoo-ntfy.exemple.test%3A8080";

describe("parseNtfyLink", () => {
  it("accepts the R4 example", () => {
    expect(parseNtfyLink(LINK)).toEqual({
      url: "http://ntfy.exemple.test:8080",
      token: "tk_exempleexempleexempleexemple",
      prefix: "upab12cd34",
      cacheSeconds: 43200,
      odooUrl: "http://odoo-ntfy.exemple.test:8080",
    });
    expect(parseNtfyLink(`  ${LINK}\n`)?.prefix).toBe("upab12cd34");
  });

  it("an absent odoo parameter reads as null, a trailing slash is dropped", () => {
    const link = "erplibre-ntfy:setup?v=1&url=https%3A%2F%2Fntfy.exemple.test%2F&token=tk_abc&prefix=upab12cd34&cache=60";
    expect(parseNtfyLink(link)).toEqual({
      url: "https://ntfy.exemple.test", token: "tk_abc", prefix: "upab12cd34", cacheSeconds: 60, odooUrl: null,
    });
  });

  it("refuses a bad scheme, a token without tk_, a prefix not up+8, a missing url, an ftp url, a cache of 10", () => {
    const bad = [
      LINK.replace("erplibre-ntfy:", "erplibre-push:"),
      LINK.replace("token=tk_", "token=xx_"),
      LINK.replace("prefix=upab12cd34", "prefix=upab12cd3"),
      LINK.replace("prefix=upab12cd34", "prefix=upAB12cd34"),
      LINK.replace("url=http%3A%2F%2Fntfy.exemple.test%3A8080&", ""),
      LINK.replace("url=http%3A%2F%2F", "url=ftp%3A%2F%2F"),
      LINK.replace("odoo=http%3A%2F%2F", "odoo=ftp%3A%2F%2F"),
      LINK.replace("cache=43200", "cache=10"),
      LINK.replace("cache=43200", "cache=604801"),
      LINK.replace("cache=43200", "cache=60.5"),
      LINK.replace("v=1", "v=2"),
      LINK.replace("token=tk_exempleexempleexempleexemple", "token=tk_exemple-exemple"),
      "",
      "not a link",
    ];
    for (const text of bad) expect(parseNtfyLink(text), text).toBeNull();
  });
});
