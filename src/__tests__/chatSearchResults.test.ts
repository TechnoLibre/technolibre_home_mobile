// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The suite's Owl stub renders nothing: this file mounts the results on the real Owl
vi.mock("@odoo/owl", async () => await import("../../node_modules/@odoo/owl/dist/owl.es.js"));

import { mount } from "@odoo/owl";
import {
    ChatSearchResultsComponent,
    conversationLabelKey,
    partnerLabelKey,
} from "../components/chat/chat_search_results_component";
import { emptyResults, type SearchHit, type SearchResults } from "../services/chat/chatSearch";

function stubStorage(lang = "fr") {
    const store: Record<string, string> = { app_lang: lang };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

const A = "https://odoo.example.com|alice|db1";

const hit = (p: Partial<SearchHit> = {}): SearchHit => ({
    configId: A, channelId: 7, messageId: 60, clientUuid: null, authorPartnerId: 4, date: "2026-10-26 10:00:00",
    snippet: "Un café <b>noir</b>", fileName: null, origin: "phone", ...p,
});

async function mounted(results: SearchResults, over: Record<string, any> = {}) {
    stubStorage();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const labels = new Map([
        [conversationLabelKey(A, 7), "#général-test"],
        [partnerLabelKey(A, 4), "Alice Martin"],
    ]);
    const props = {
        results, term: "cafe", server: "idle", count: null, more: false, labels,
        onConversation: vi.fn(), onHit: vi.fn(), onMailbox: vi.fn(), onPerson: vi.fn(), onJoin: vi.fn(), onMore: vi.fn(),
        ...over,
    };
    const component = await mount(ChatSearchResultsComponent as any, host, { props, env: {} } as any);
    return { host, props, destroy: () => (component as any).__owl__.app.destroy() };
}

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
});

describe("ChatSearchResultsComponent", () => {
    it("shows only the sections that have results, under their headings", async () => {
        const results = { ...emptyResults(), messages: [hit()], people: [{ configId: A, partner: { configId: A, partnerId: 4, name: "Café Martin", imStatus: null } }] };
        const { host, destroy } = await mounted(results);
        expect([...host.querySelectorAll(".chat-search__heading")].map((h) => h.textContent)).toEqual(["Personnes", "Messages"]);
        destroy();
    });

    it("a hit names its author and conversation, the term marked in text nodes only", async () => {
        const { host, props, destroy } = await mounted({ ...emptyResults(), messages: [hit()] });
        const item = host.querySelector(".chat-search__hit")!;
        expect(item.querySelector(".chat-search__author")!.textContent).toBe("Alice Martin");
        expect(item.querySelector(".chat-search__where")!.textContent).toBe("#général-test");
        const snippet = item.querySelector(".chat-search__snippet")!;
        expect([...snippet.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["café"]);
        expect(snippet.querySelector("b")).toBeNull();
        expect(snippet.textContent).toContain("<b>noir</b>");
        (item as HTMLElement).click();
        expect(props.onHit).toHaveBeenCalledWith(props.results.messages[0]);
        destroy();
    });

    it("the server tag shows when the labels name the server", async () => {
        const labels = new Map([[A, "Serveur démo"]]);
        const { host, destroy } = await mounted({ ...emptyResults(), messages: [hit({ authorPartnerId: null })] }, { labels });
        expect(host.querySelector(".chat-search__tag")!.textContent).toBe("Serveur démo");
        expect(host.querySelector(".chat-search__author")!.textContent).toBe("Quelqu'un");
        destroy();
    });

    it("a mailbox item shows its record name, its kind and its snippet, and opens through onMailbox", async () => {
        const item = {
            configId: A, messageId: 90, threadModel: "project.task", threadId: 5, recordName: "Tâche café", authorPartnerId: 4,
            body: "<p>prêt</p>", date: null, messageType: "comment", needaction: true, starred: false, history: false,
        };
        const { host, props, destroy } = await mounted({ ...emptyResults(), mailbox: [{ item, snippet: "prêt" }] });
        expect(host.querySelector(".chat-search__heading")!.textContent).toBe("Boîte de réception et favoris");
        expect(host.querySelector(".chat-search__record mark")!.textContent).toBe("café");
        expect(host.querySelector(".chat-search__kind")!.textContent).toBe("Fiche suivie");
        (host.querySelector(".chat-search__hit") as HTMLElement).click();
        expect(props.onMailbox).toHaveBeenCalledWith(item);
        destroy();
    });

    it("conversations, files, people and channels to join call their own callbacks", async () => {
        const results: SearchResults = {
            ...emptyResults(),
            conversations: [{ configId: A, channelId: 7 }],
            files: [hit({ snippet: "café.pdf", fileName: "café.pdf" })],
            people: [{ configId: A, partner: { configId: A, partnerId: 4, name: "Alice Martin", imStatus: null } }],
            joinable: [{ configId: A, channel: { channelId: 9, name: "café-test", description: "", memberCount: 3, groupName: "" } }],
        };
        const { host, props, destroy } = await mounted(results);
        const items = [...host.querySelectorAll<HTMLElement>(".chat-search__item")];
        items.forEach((b) => b.click());
        expect(props.onConversation).toHaveBeenCalledWith(A, 7);
        expect(props.onPerson).toHaveBeenCalledWith(A, 4);
        expect(props.onJoin).toHaveBeenCalledWith(A, 9);
        expect(props.onHit).toHaveBeenCalledWith(results.files[0]);
        destroy();
    });

    it("the status line follows the server part, and nothing found says so", async () => {
        const states: [string, number | null, string][] = [
            ["loading", null, "Recherche sur le serveur…"],
            ["offline", null, "Hors ligne : résultats du téléphone seulement."],
            ["error", null, "La recherche sur le serveur a échoué : résultats du téléphone seulement."],
            ["done", 1, "1 message trouvé sur le serveur"],
            ["done", 12, "12 messages trouvés sur le serveur"],
        ];
        for (const [server, count, text] of states) {
            const { host, destroy } = await mounted(emptyResults(), { server, count });
            expect(host.querySelector(".chat-search__status")?.textContent).toBe(text);
            expect(!!host.querySelector(".chat-search__none")).toBe(server !== "loading");
            destroy();
        }
        const idle = await mounted(emptyResults());
        expect(idle.host.querySelector(".chat-search__status")).toBeNull();
        expect(idle.host.querySelector(".chat-search__none")!.textContent).toBe("Aucun résultat.");
        idle.destroy();
    });

    it("more results is offered only when the server has more", async () => {
        const { host, props, destroy } = await mounted({ ...emptyResults(), messages: [hit()] }, { server: "done", count: 40, more: true });
        (host.querySelector(".chat-search__more") as HTMLElement).click();
        expect(props.onMore).toHaveBeenCalledTimes(1);
        destroy();
        const none = await mounted({ ...emptyResults(), messages: [hit()] });
        expect(none.host.querySelector(".chat-search__more")).toBeNull();
        none.destroy();
    });
});
