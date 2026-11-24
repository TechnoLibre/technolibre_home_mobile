import { describe, it, expect } from "vitest";
import { CHAT_MAJOR, parseOdooMajor, serverChoiceMode, sourceLabels } from "../services/chat/chatSources";

const app = (url: string, database = "db", username = "ana") => ({ url, database, username });

describe("parseOdooMajor", () => {
  it("reads the major of the usual version strings", () => {
    expect(parseOdooMajor("18.0")).toBe(18);
    expect(parseOdooMajor("18.0+e")).toBe(18);
    expect(parseOdooMajor("saas~17.4")).toBe(17);
    expect(parseOdooMajor("")).toBeNull();
    expect(parseOdooMajor("abc")).toBeNull();
    expect(CHAT_MAJOR).toBe(18);
  });
});

describe("serverChoiceMode", () => {
  it("maps the number of sources to the choice widget", () => {
    expect(serverChoiceMode(0)).toBe("unavailable");
    expect(serverChoiceMode(1)).toBe("none");
    expect(serverChoiceMode(2)).toBe("chips");
    expect(serverChoiceMode(4)).toBe("chips");
    expect(serverChoiceMode(5)).toBe("dropdown");
    expect(serverChoiceMode(9)).toBe("dropdown");
  });
});

describe("sourceLabels", () => {
  it("uses the first DNS label when it is unique", () => {
    expect(sourceLabels([app("https://bureau.example.org")])).toEqual(["bureau"]);
    expect(sourceLabels([app("https://bureau.example.org"), app("https://atelier.example.org")])).toEqual([
      "bureau",
      "atelier",
    ]);
  });

  it("widens to the full host only for the colliding group", () => {
    expect(
      sourceLabels([
        app("https://bureau.example.org"),
        app("https://bureau.example.net"),
        app("https://atelier.example.org"),
      ]),
    ).toEqual(["bureau.example.org", "bureau.example.net", "atelier"]);
  });

  it("widens to host/db when the host is the same", () => {
    expect(sourceLabels([app("https://bureau.example.org", "a"), app("https://bureau.example.org", "b")])).toEqual([
      "bureau.example.org/a",
      "bureau.example.org/b",
    ]);
  });

  it("adds the user when host and database are the same", () => {
    expect(
      sourceLabels([app("https://bureau.example.org", "a", "ana"), app("https://bureau.example.org", "a", "bob")]),
    ).toEqual(["bureau · ana", "bureau · bob"]);
  });

  it("keeps a distinct label for every source of a mixed set", () => {
    const labels = sourceLabels([
      app("https://bureau.example.org", "a", "ana"),
      app("https://bureau.example.org", "a", "bob"),
      app("https://bureau.example.org", "b", "ana"),
      app("https://atelier.example.org"),
    ]);
    expect(new Set(labels).size).toBe(4);
    expect(labels[3]).toBe("atelier");
  });
});
