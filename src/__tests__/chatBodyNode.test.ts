import { describe, expect, it } from "vitest";

import { EDITED_CLASS, bodyText, chatMarker, isEdited, mentionAnchors } from "../services/chat/chatBody";

// The node environment, as chatOutbox.test.ts, chatService.test.ts and the
// long tests run: DOMParser comes from the setup file, not from jsdom's window
describe("chatBody in the node environment", () => {
  it("has no document, only DOMParser", () => {
    expect(typeof document).toBe("undefined");
    expect(typeof DOMParser).toBe("function");
  });

  it("bodyText, isEdited and mentionAnchors read a body", () => {
    const body = '<p><a class="o_mail_redirect" data-oe-id="7" data-oe-model="res.partner">@Alice Martin</a>'
      + ` &amp; a<br>b<span class="${EDITED_CLASS}"></span></p>${chatMarker("u")}`;
    expect(bodyText(body)).toBe("@Alice Martin & a\nb");
    expect(isEdited(body)).toBe(true);
    expect(mentionAnchors(body)).toEqual({ partners: [7], channels: [] });
  });
});
