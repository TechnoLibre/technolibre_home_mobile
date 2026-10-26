import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { t } from "../../i18n";
import { mailboxKindOf, type ChatMailboxItem } from "../../models/chat";
import { markParts, type MarkPart, type SearchHit, type SearchResults } from "../../services/chat/chatSearch";

/** How the server part of a search stands: not asked, running, not reachable, answered, or failed. */
export type ServerSearchState = "idle" | "loading" | "offline" | "done" | "error";

/**
 * The keys of the `labels` prop: the account itself names its server
 * (present only when the list shows servers), `configId:channelId` a
 * conversation's title, `configId#p<partnerId>` a person's name.
 */
export const conversationLabelKey = (configId: string, channelId: number): string => `${configId}:${channelId}`;
export const partnerLabelKey = (configId: string, partnerId: number): string => `${configId}#p${partnerId}`;

const KIND_LABELS = { mention: "chat.search_kind_mention", record: "chat.search_kind_record", assignment: "chat.search_kind_assignment" };

/**
 * The results of a search, in place of the conversation list: the
 * conversations, the people, the channels to join, the messages, the files
 * and the inbox and favourite items, each section hidden when empty. A
 * hit names its author and its conversation, with the server's tag when
 * the list shows servers; every place of the term is in a `<mark>`, as
 * text nodes only. A status line says how the server part stands;
 * `count` is the server's number of matches (null when not known) and
 * `more` offers its next page.
 */
export class ChatSearchResultsComponent extends EnhancedComponent {
    static props = {
        results: Object,
        term: { type: String, optional: true },
        server: String,
        count: { optional: true },
        more: Boolean,
        labels: Map,
        onConversation: Function,
        onHit: Function,
        onMailbox: Function,
        onPerson: Function,
        onJoin: Function,
        onMore: Function,
    };

    static template = xml`
    <div class="chat-search">
      <p t-if="statusText()" class="chat-search__status" role="status" t-esc="statusText()"/>
      <p t-if="isEmpty()" class="chat-search__none" t-esc="t('chat.search_none')"/>
      <section t-if="props.results.conversations.length" class="chat-search__section">
        <h3 class="chat-search__heading" t-esc="t('chat.search_conversations')"/>
        <ul class="chat-search__list">
          <li t-foreach="props.results.conversations" t-as="c" t-key="c.configId + ':' + c.channelId">
            <button type="button" class="chat-search__item" t-on-click="() => props.onConversation(c.configId, c.channelId)">
              <span class="chat-search__title">
                <t t-foreach="parts(conversationName(c.configId, c.channelId))" t-as="p" t-key="p_index"><mark t-if="p.mark" t-esc="p.text"/><t t-else="" t-esc="p.text"/></t>
              </span>
              <span t-if="serverOf(c.configId)" class="chat-search__tag" t-esc="serverOf(c.configId)"/>
            </button>
          </li>
        </ul>
      </section>
      <section t-if="props.results.people.length" class="chat-search__section">
        <h3 class="chat-search__heading" t-esc="t('chat.search_people')"/>
        <ul class="chat-search__list">
          <li t-foreach="props.results.people" t-as="p" t-key="p.configId + '#' + p.partner.partnerId">
            <button type="button" class="chat-search__item" t-on-click="() => props.onPerson(p.configId, p.partner.partnerId)">
              <span class="chat-search__title">
                <t t-foreach="parts(p.partner.name)" t-as="x" t-key="x_index"><mark t-if="x.mark" t-esc="x.text"/><t t-else="" t-esc="x.text"/></t>
              </span>
              <span t-if="serverOf(p.configId)" class="chat-search__tag" t-esc="serverOf(p.configId)"/>
            </button>
          </li>
        </ul>
      </section>
      <section t-if="props.results.joinable.length" class="chat-search__section">
        <h3 class="chat-search__heading" t-esc="t('chat.search_joinable')"/>
        <ul class="chat-search__list">
          <li t-foreach="props.results.joinable" t-as="j" t-key="j.configId + '#' + j.channel.channelId">
            <button type="button" class="chat-search__item" t-on-click="() => props.onJoin(j.configId, j.channel.channelId)">
              <span class="chat-search__title">
                <t t-foreach="parts(j.channel.name)" t-as="x" t-key="x_index"><mark t-if="x.mark" t-esc="x.text"/><t t-else="" t-esc="x.text"/></t>
              </span>
              <span class="chat-search__note" t-esc="t('chat.join')"/>
              <span t-if="serverOf(j.configId)" class="chat-search__tag" t-esc="serverOf(j.configId)"/>
            </button>
          </li>
        </ul>
      </section>
      <section t-if="props.results.messages.length" class="chat-search__section">
        <h3 class="chat-search__heading" t-esc="t('chat.search_messages')"/>
        <ul class="chat-search__list">
          <li t-foreach="props.results.messages" t-as="h" t-key="hitKey(h)">
            <button type="button" class="chat-search__item chat-search__hit" t-on-click="() => props.onHit(h)">
              <span class="chat-search__meta">
                <span class="chat-search__author" t-esc="authorOf(h)"/>
                <span class="chat-search__where" t-esc="conversationName(h.configId, h.channelId)"/>
                <span t-if="serverOf(h.configId)" class="chat-search__tag" t-esc="serverOf(h.configId)"/>
              </span>
              <span class="chat-search__snippet">
                <t t-foreach="parts(h.snippet)" t-as="x" t-key="x_index"><mark t-if="x.mark" t-esc="x.text"/><t t-else="" t-esc="x.text"/></t>
              </span>
            </button>
          </li>
        </ul>
      </section>
      <section t-if="props.results.files.length" class="chat-search__section">
        <h3 class="chat-search__heading" t-esc="t('chat.search_files')"/>
        <ul class="chat-search__list">
          <li t-foreach="props.results.files" t-as="h" t-key="hitKey(h) + '#' + h.fileName">
            <button type="button" class="chat-search__item chat-search__hit" t-on-click="() => props.onHit(h)">
              <span class="chat-search__snippet">
                <span aria-hidden="true">📎 </span>
                <t t-foreach="parts(h.snippet)" t-as="x" t-key="x_index"><mark t-if="x.mark" t-esc="x.text"/><t t-else="" t-esc="x.text"/></t>
              </span>
              <span class="chat-search__meta">
                <span class="chat-search__author" t-esc="authorOf(h)"/>
                <span class="chat-search__where" t-esc="conversationName(h.configId, h.channelId)"/>
                <span t-if="serverOf(h.configId)" class="chat-search__tag" t-esc="serverOf(h.configId)"/>
              </span>
            </button>
          </li>
        </ul>
      </section>
      <section t-if="props.results.mailbox.length" class="chat-search__section">
        <h3 class="chat-search__heading" t-esc="t('chat.search_mailbox')"/>
        <ul class="chat-search__list">
          <li t-foreach="props.results.mailbox" t-as="m" t-key="m.item.configId + '#' + m.item.messageId">
            <button type="button" class="chat-search__item chat-search__hit" t-on-click="() => props.onMailbox(m.item)">
              <span class="chat-search__meta">
                <span class="chat-search__record">
                  <t t-foreach="parts(m.item.recordName)" t-as="x" t-key="x_index"><mark t-if="x.mark" t-esc="x.text"/><t t-else="" t-esc="x.text"/></t>
                </span>
                <span class="chat-search__kind" t-esc="kindOf(m.item)"/>
                <span t-if="serverOf(m.item.configId)" class="chat-search__tag" t-esc="serverOf(m.item.configId)"/>
              </span>
              <span class="chat-search__snippet">
                <t t-foreach="parts(m.snippet)" t-as="x" t-key="x_index"><mark t-if="x.mark" t-esc="x.text"/><t t-else="" t-esc="x.text"/></t>
              </span>
            </button>
          </li>
        </ul>
      </section>
      <button t-if="props.more" type="button" class="chat-search__more" t-on-click="() => props.onMore()" t-esc="t('chat.search_more')"/>
    </div>`;

    /** The pieces of a text, the places of the term (the `term` prop; none marks nothing) marked. */
    parts(text: string): MarkPart[] {
        return markParts(text, this.props.term ?? "");
    }

    hitKey(h: SearchHit): string {
        return `${h.origin}#${h.configId}#${h.messageId ?? "u" + h.clientUuid}`;
    }

    conversationName(configId: string, channelId: number): string {
        return this.props.labels.get(conversationLabelKey(configId, channelId)) ?? "?";
    }

    authorOf(h: SearchHit): string {
        if (h.authorPartnerId === null) return t("chat.someone");
        return this.props.labels.get(partnerLabelKey(h.configId, h.authorPartnerId)) || t("chat.someone");
    }

    serverOf(configId: string): string {
        return this.props.labels.get(configId) ?? "";
    }

    kindOf(item: ChatMailboxItem): string {
        return t(KIND_LABELS[mailboxKindOf(item)]);
    }

    /** No section to show, and nothing more to wait for from the server. */
    isEmpty(): boolean {
        const r = this.props.results as SearchResults;
        const none = !r.conversations.length && !r.people.length && !r.joinable.length
            && !r.messages.length && !r.files.length && !r.mailbox.length;
        return none && this.props.server !== "loading";
    }

    statusText(): string {
        switch (this.props.server as ServerSearchState) {
            case "loading":
                return t("chat.search_server_loading");
            case "offline":
                return t("chat.search_server_offline");
            case "error":
                return t("chat.search_server_error");
            case "done":
                return this.props.count === null || this.props.count === undefined
                    ? ""
                    : t(this.props.count === 1 ? "chat.search_server_count_one" : "chat.search_server_count_other", { count: this.props.count });
            default:
                return "";
        }
    }
}
