import type { ChatPartner } from "../../models/chat";
import { t } from "../../i18n";
import { RequestNotSentError, type OdooRpcClient } from "../odoo/odooRpcClient";
import type { ChatRepository } from "./chatRepository";
import type { ChatSource } from "./chatSources";
import { foldText as fold } from "./chatBody";
import { parseStore, type StoreDelta } from "./chatStore";

/** A public channel the user is not in yet, as the list of channels to join shows it. */
export interface JoinableChannel {
  channelId: number;
  name: string;
  description: string;
  memberCount: number;
  /** Full name of the group that may join; "" for a channel open to everyone. */
  groupName: string;
}

/** An access group a new channel can be restricted to; `id` false is "everyone". */
export interface AccessGroup {
  id: number | false;
  fullName: string;
}

/** A delta carrying only partner records. */
const partnersDelta = (partners: StoreDelta["partners"], selfPartnerId: number | null): StoreDelta => ({
  channels: [],
  deletedChannelIds: [],
  members: [],
  deletedMemberIds: [],
  messages: [],
  attachments: [],
  deletedAttachmentIds: [],
  partners,
  inboxCounter: null,
  selfPartnerId,
});

/**
 * Who the user can write to, which public channels they can join and which
 * access groups a new channel can take, per server. Reads go to the server
 * when online; a request that never left (RequestNotSentError) or no network
 * falls back to the cache where one exists. Other errors propagate. Holds no
 * state of its own, so it tests over fakes of the rpc client and the cache.
 */
export class ChatPeople {
  constructor(
    private rpc: OdooRpcClient,
    private repo: ChatRepository,
    private isOnline: () => Promise<boolean>,
  ) {}

  /**
   * Correspondents of the cached shown chats, the most recent first
   * (lastInterestDt desc, then channel id desc), once each, self left out. A
   * correspondent not in the partner cache is left out. Cache only.
   */
  async recentPeople(configId: string): Promise<ChatPartner[]> {
    const [channels, partners, state] = await Promise.all([
      this.repo.channels(configId),
      this.repo.partners(configId),
      this.repo.sourceState(configId),
    ]);
    const byId = new Map(partners.map((p) => [p.partnerId, p]));
    const recent = channels
      .filter((c) => c.channelType === "chat" && c.isPinned && c.isMember && c.correspondentPartnerId !== null)
      .sort((a, b) => (b.lastInterestDt ?? "").localeCompare(a.lastInterestDt ?? "") || b.channelId - a.channelId);
    const seen = new Set<number>();
    const out: ChatPartner[] = [];
    for (const c of recent) {
      const id = c.correspondentPartnerId as number;
      const partner = byId.get(id);
      if (id === state.selfPartnerId || seen.has(id) || !partner) continue;
      seen.add(id);
      out.push(partner);
    }
    return out;
  }

  /**
   * Internal users whose name contains `term` (`res.partner.im_search`; the
   * server never returns the caller). The partners found are merged into the
   * cache. Offline, or when the request was not sent, the cached partners
   * whose name contains `term` (case and accents ignored) answer instead,
   * the recent ones first, then by name. At most `limit` partners.
   */
  async searchPeople(src: ChatSource, term: string, limit = 20): Promise<ChatPartner[]> {
    if (await this.isOnline()) {
      try {
        const result = await this.rpc.callKw(src.creds, "res.partner", "im_search", [term, limit, []]);
        return await this.merged(src.configId, result);
      } catch (e) {
        if (!(e instanceof RequestNotSentError)) throw e;
      }
    }
    return this.searchCached(src.configId, term, limit);
  }

  /**
   * Public channels (no parent, not sub-channels) the user is not a member
   * of and whose name contains `term`, by name. They are not cached: the
   * user is not a member, so none is a conversation. Offline, or when the
   * request was not sent: no channels and `offline` true.
   */
  async joinableChannels(
    src: ChatSource,
    term = "",
    limit = 50,
  ): Promise<{ channels: JoinableChannel[]; offline: boolean }> {
    if (!(await this.isOnline())) return { channels: [], offline: true };
    try {
      const rows = await this.rpc.searchRead<any>(
        src.creds,
        "discuss.channel",
        [
          ["parent_channel_id", "=", false],
          ["channel_type", "=", "channel"],
          ["is_member", "=", false],
          ["name", "ilike", term],
        ],
        ["name", "description", "member_count", "group_public_id"],
        { limit, order: "name" },
      );
      const channels = rows.map((r) => ({
        channelId: r.id,
        name: r.name || "",
        description: typeof r.description === "string" ? r.description : "",
        memberCount: Number(r.member_count) || 0,
        groupName: Array.isArray(r.group_public_id) ? String(r.group_public_id[1] ?? "") : "",
      }));
      return { channels, offline: false };
    } catch (e) {
      if (e instanceof RequestNotSentError) return { channels: [], offline: true };
      throw e;
    }
  }

  /**
   * Users who can be added to the channel (`search_for_channel_invite`):
   * name or email contains `term`, not members yet, and in the channel's
   * group when it has one. `count` is the number of matches on the server,
   * which may exceed the partners returned. The partners are merged into the
   * cache. Offline, or when the request was not sent: none and `offline`.
   */
  async inviteCandidates(
    src: ChatSource,
    channelId: number,
    term: string,
  ): Promise<{ partners: ChatPartner[]; count: number; offline: boolean }> {
    if (!(await this.isOnline())) return { partners: [], count: 0, offline: true };
    try {
      const result = await this.rpc.callKw(src.creds, "res.partner", "search_for_channel_invite", [term, channelId]);
      const partners = await this.merged(src.configId, result?.data);
      return { partners, count: Number(result?.count) || partners.length, offline: false };
    } catch (e) {
      if (e instanceof RequestNotSentError) return { partners: [], count: 0, offline: true };
      throw e;
    }
  }

  /**
   * The access groups a new channel can take: the user's own groups (not
   * portal/public ones) by full name, then "everyone" (`id` false) last.
   * `defaultId` is Odoo's default, the internal-users group; when the user's
   * groups do not list it, it is still offered, first. Offline, or when the
   * request was not sent: only that default (when known) and "everyone", and
   * `offline` true.
   */
  async accessGroups(
    src: ChatSource,
  ): Promise<{ groups: AccessGroup[]; defaultId: number | false; offline: boolean }> {
    const defaultId = (await this.repo.sourceState(src.configId)).internalUserGroupId ?? false;
    const everyone: AccessGroup = { id: false, fullName: t("chat.access_everyone") };
    const internal: AccessGroup[] =
      defaultId === false ? [] : [{ id: defaultId, fullName: t("chat.access_internal") }];
    const fallback = { groups: [...internal, everyone], defaultId, offline: true };
    if (!(await this.isOnline())) return fallback;
    try {
      const { uid } = await this.rpc.sessionInfo(src.creds);
      const rows = await this.rpc.searchRead<{ id: number; full_name: string }>(
        src.creds,
        "res.groups",
        [["share", "=", false], ["users", "in", [uid]]],
        ["full_name"],
      );
      const groups: AccessGroup[] = rows
        .map((r) => ({ id: r.id, fullName: r.full_name || "" }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
      if (defaultId !== false && !groups.some((g) => g.id === defaultId)) groups.unshift(internal[0]);
      return { groups: [...groups, everyone], defaultId, offline: false };
    } catch (e) {
      if (e instanceof RequestNotSentError) return fallback;
      throw e;
    }
  }

  /** Merges the partners of a Store result into the cache and returns them as cached, in the name order. */
  private async merged(configId: string, storeResult: any): Promise<ChatPartner[]> {
    const state = await this.repo.sourceState(configId);
    const delta = parseStore(storeResult, configId, state.selfPartnerId);
    await this.repo.applyDelta(configId, partnersDelta(delta.partners, state.selfPartnerId));
    const byId = new Map((await this.repo.partners(configId)).map((p) => [p.partnerId, p]));
    return delta.partners
      .map((p) => byId.get(p.partnerId))
      .filter((p): p is ChatPartner => !!p)
      .sort((a, b) => fold(a.name).localeCompare(fold(b.name)) || a.partnerId - b.partnerId);
  }

  /**
   * The cached partners with a name holding `term` (case and accents
   * ignored), self left out: the recent ones first (recentPeople), then by
   * name and id. At most `limit`. Cache only.
   */
  async searchCached(configId: string, term: string, limit: number): Promise<ChatPartner[]> {
    const needle = fold(term);
    const state = await this.repo.sourceState(configId);
    const recent = await this.recentPeople(configId);
    const rank = new Map(recent.map((p, i) => [p.partnerId, i]));
    const rest = (await this.repo.partners(configId)).filter((p) => p.partnerId !== state.selfPartnerId);
    return rest
      .filter((p) => p.name !== "" && fold(p.name).includes(needle))
      .sort(
        (a, b) =>
          (rank.get(a.partnerId) ?? Infinity) - (rank.get(b.partnerId) ?? Infinity) ||
          fold(a.name).localeCompare(fold(b.name)) ||
          a.partnerId - b.partnerId,
      )
      .slice(0, limit);
  }
}
