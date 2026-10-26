// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  EDITED_CLASS, attachmentPreview, bodyHasMarker, bodyPreview, bodyText, chatMarker, foldText, isEdited, isEmptyBody,
  isEmptyMessage, mentionAnchors, renderBody, searchTextOf, withEditedMark,
} from "../services/chat/chatBody";

const MENTION = '<a href="/odoo/res.partner/7" class="o_mail_redirect" data-oe-id="7" data-oe-model="res.partner" target="_blank">@Alice Martin</a>';
const CHANNEL = '<a href="/odoo/discuss.channel/3" class="o_channel_redirect" data-oe-id="3" data-oe-model="discuss.channel" target="_blank">#général-test</a>';

describe("chatMarker", () => {
  it("is found by bodyHasMarker", () => {
    const out = "hi" + chatMarker("u1");
    expect(chatMarker("u1")).toBe("<!-- erplibre-mobile:u1 -->");
    expect(bodyHasMarker(out, "u1")).toBe(true);
    expect(bodyHasMarker(out, "u2")).toBe(false);
  });
});

describe("renderBody", () => {
  it("keeps whitelisted tags and href", () => {
    const out = renderBody('<p>a <b>b</b> <a href="https://x.org">l</a></p><ul><li>i</li></ul>');
    expect(out).toContain("<b>b</b>");
    expect(out).toContain('href="https://x.org"');
    expect(out).toContain("<li>i</li>");
  });

  it("removes scripts, styles, iframes, events and javascript hrefs", () => {
    const out = renderBody(
      '<script>x()</script><style>p{}</style><iframe src="y"></iframe><p onclick="z()" style="c:r">t</p>' +
        '<a href=" JaVa\nScript:alert(1)" onmouseover="q">l</a><span class="k">s</span>',
    );
    expect(out).not.toMatch(/script|style|iframe|onclick|onmouseover|javascript/i);
    expect(out).toContain("t");
    expect(out).not.toContain("class=\"k\"");
  });

  it("keeps a mention chip and drops its href", () => {
    const out = renderBody(`<p>${MENTION} et ${CHANNEL} <a href="#" class="o-discuss-mention">@everyone</a></p>`, { selfPartnerId: 9 });
    expect(out).toBe(
      '<p><a class="chat-msg__mention" data-oe-id="7" data-oe-model="res.partner">@Alice Martin</a> et '
        + '<a class="chat-msg__channel" data-oe-id="3" data-oe-model="discuss.channel">#général-test</a> '
        + '<a class="chat-msg__special">@everyone</a></p>',
    );
    expect(renderBody(MENTION, { selfPartnerId: 7 })).toContain('class="chat-msg__mention chat-msg__mention--self"');
    const thread = renderBody('<a href="/odoo/discuss.channel/4" class="o_channel_redirect o_channel_redirect_asThread" '
      + 'data-oe-id="4" data-oe-model="discuss.channel">#général-test &gt; sous-fil</a>');
    expect(thread).toBe('<a class="chat-msg__channel" data-oe-id="4" data-oe-model="discuss.channel">#général-test &gt; sous-fil</a>');
  });

  it("refuses a data-oe-model it does not know", () => {
    expect(renderBody('<a href="#" class="o_mail_redirect" data-oe-id="5" data-oe-model="res.users">@x</a>')).toBe("<a>@x</a>");
    expect(renderBody('<a class="o_mail_redirect" data-oe-id="5 or 1" data-oe-model="res.partner">@x</a>')).toBe("<a>@x</a>");
    // A chip class of the other model is no chip either
    expect(renderBody('<a class="o_channel_redirect" data-oe-id="5" data-oe-model="res.partner">#x</a>')).toBe("<a>#x</a>");
  });

  it("shows « (modifié) » where the span was", () => {
    const body = `<p>texte<span class="${EDITED_CLASS}"></span></p>`;
    expect(renderBody(body, { editedLabel: "(modifié)" })).toBe('<p>texte<em class="chat-msg__edited"> (modifié)</em></p>');
    expect(renderBody(body)).toBe("<p>texte</p>");
  });

  it("replaces images by a placeholder and drops comments", () => {
    const out = renderBody('<p>a<img src="x.png"></p><!-- erplibre-mobile:u -->');
    expect(out).toContain('<span class="chat-msg__image">🖼️</span>');
    expect(out).not.toContain("img");
    expect(out).not.toContain("erplibre-mobile");
  });
});

describe("bodyText", () => {
  it("of <p>a<br>b</p> is \"a\\nb\"", () => {
    expect(bodyText("<p>a<br>b</p>")).toBe("a\nb");
  });

  it("gives mentions as their text and links as typed, without the marker or the edited mark", () => {
    const linked = '<a target="_blank" rel="noreferrer noopener" href="https://example.com/">https://example.com</a>';
    expect(bodyText(`<p>${MENTION} &amp; ${linked}<br/>fin<span class="${EDITED_CLASS}"></span></p>${chatMarker("u")}`))
      .toBe("@Alice Martin & https://example.com\nfin");
  });
});

describe("foldText and searchTextOf", () => {
  it("foldText lowers the case and drops the accents", () => {
    expect(foldText("ÉLÈVE Ça Où")).toBe("eleve ca ou");
  });

  it("searchTextOf is the folded text of the body", () => {
    expect(searchTextOf("<p>Café <b>crème</b></p>")).toBe("cafe creme");
  });

  it("searchTextOf reads the marker comment and the edited span as nothing", () => {
    expect(searchTextOf(`<p>Réunion ${MENTION}</p>${chatMarker("u1")}<span class="${EDITED_CLASS}"></span>`))
      .toBe("reunion @alice martin");
  });
});

describe("edited and empty bodies", () => {
  it("isEmptyBody of the lone edited span is true", () => {
    expect(isEmptyBody(`<span class="${EDITED_CLASS}"></span>`)).toBe(true);
    expect(isEmptyBody("")).toBe(true);
    expect(isEmptyBody("<p><br></p>")).toBe(true);
    expect(isEmptyBody(" <p> </p> ")).toBe(true);
    expect(isEmptyBody("<p>x</p>")).toBe(false);
  });

  it("isEmptyMessage keeps an emptied body with a file", () => {
    expect(isEmptyMessage("", 1)).toBe(false);
    expect(isEmptyMessage("", 0)).toBe(true);
    expect(isEmptyMessage("<p>x</p>", 0)).toBe(false);
  });

  it("withEditedMark appends the span isEdited finds", () => {
    expect(isEdited("<p>x</p>")).toBe(false);
    expect(withEditedMark("<p>x</p>")).toBe(`<p>x</p><span class="${EDITED_CLASS}"></span>`);
    expect(isEdited(withEditedMark("<p>x</p>"))).toBe(true);
    expect(isEdited(`<p>x<span class='${EDITED_CLASS}'/></p>`)).toBe(true);
  });
});

describe("mentionAnchors", () => {
  it("lists the partners and channels linked in a body, once each", () => {
    const other = '<a class="o_mail_redirect" data-oe-id="5" data-oe-model="res.users">@y</a>';
    expect(mentionAnchors(`<p>${MENTION} ${CHANNEL} ${MENTION} ${other}</p>`)).toEqual({ partners: [7], channels: [3] });
    expect(mentionAnchors("<p>rien</p>")).toEqual({ partners: [], channels: [] });
  });
});

describe("bodyPreview", () => {
  it("flattens to text", () => {
    expect(bodyPreview("<p>Hello<br>world</p><!-- erplibre-mobile:u -->", 80)).toBe("Hello world");
  });

  it("truncates", () => {
    expect(bodyPreview("<p>abcdefghij</p>", 5)).toBe("abcd…");
  });
});

describe("attachmentPreview", () => {
  const file = (name: string, mimetype: string, voice = false) => ({ name, mimetype, voice });

  it("names a voice message, an image or a file by its icon", () => {
    localStorage.setItem("app_lang", "en");
    expect(attachmentPreview([file("Voice-2026-10-26-1.mp3", "audio/mpeg", true)])).toBe("🎤 Voice message");
    expect(attachmentPreview([file("IMG_1.jpg", "image/jpeg")])).toBe("🖼️ IMG_1.jpg");
    expect(attachmentPreview([file("report.pdf", "application/pdf")])).toBe("📎 report.pdf");
    // As the thread shows them: other audio plays (🎤), a HEIC or a TIFF opens as a file
    expect(attachmentPreview([file("song.ogg", "audio/ogg")])).toBe("🎤 song.ogg");
    expect(attachmentPreview([file("IMG_2.heic", "image/heic")])).toBe("📎 IMG_2.heic");
    expect(attachmentPreview([file("scan.tiff", "image/tiff")])).toBe("📎 scan.tiff");
    localStorage.setItem("app_lang", "fr");
    expect(attachmentPreview([file("Voice-2026-10-26-1.mp3", "audio/mpeg", true)])).toBe("🎤 Message vocal");
  });

  it("lists several files and cuts to the length", () => {
    expect(attachmentPreview([file("a.jpg", "image/jpeg"), file("b.pdf", "application/pdf")])).toBe("🖼️ a.jpg, 📎 b.pdf");
    expect(attachmentPreview([file("abcdefghij.pdf", "application/pdf")], 8)).toBe("📎 abcd…");
    expect(attachmentPreview([])).toBe("");
  });
});
