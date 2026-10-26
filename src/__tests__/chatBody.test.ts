// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { attachmentPreview, bodyHasMarker, bodyPreview, chatMarker, renderBody, textToBody } from "../services/chat/chatBody";

describe("textToBody", () => {
  it("escapes and turns newlines into br", () => {
    expect(textToBody("a < b\nc", null)).toBe("a &lt; b<br>c");
    expect(textToBody(`"x" & 'y' > z`, null)).toBe("&quot;x&quot; &amp; &#39;y&#39; &gt; z");
  });

  it("links http(s) URLs only", () => {
    expect(textToBody("see https://x.org/a?b=1&c now", null)).toBe(
      'see <a href="https://x.org/a?b=1&amp;c" target="_blank" rel="noreferrer noopener">https://x.org/a?b=1&amp;c</a> now',
    );
    expect(textToBody("javascript:alert(1) ftp://x.org", null)).not.toContain("<a");
  });

  it("does not let a quote end the href", () => {
    const out = textToBody('https://x.org/"onmouseover="x', null);
    expect(out).not.toContain('"onmouseover');
  });

  it("appends the marker, found by bodyHasMarker", () => {
    const out = textToBody("hi", "u1");
    expect(out.endsWith("<!-- erplibre-mobile:u1 -->")).toBe(true);
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

  it("replaces images by a placeholder and drops comments", () => {
    const out = renderBody('<p>a<img src="x.png"></p><!-- erplibre-mobile:u -->');
    expect(out).toContain('<span class="chat-msg__image">🖼️</span>');
    expect(out).not.toContain("img");
    expect(out).not.toContain("erplibre-mobile");
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
    expect(attachmentPreview([file("song.ogg", "audio/ogg")])).toBe("📎 song.ogg");
    localStorage.setItem("app_lang", "fr");
    expect(attachmentPreview([file("Voice-2026-10-26-1.mp3", "audio/mpeg", true)])).toBe("🎤 Message vocal");
  });

  it("lists several files and cuts to the length", () => {
    expect(attachmentPreview([file("a.jpg", "image/jpeg"), file("b.pdf", "application/pdf")])).toBe("🖼️ a.jpg, 📎 b.pdf");
    expect(attachmentPreview([file("abcdefghij.pdf", "application/pdf")], 8)).toBe("📎 abcd…");
    expect(attachmentPreview([])).toBe("");
  });
});
