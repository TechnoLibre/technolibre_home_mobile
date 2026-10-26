import { ChatModuleState } from "../../models/chat";
import { CapabilityService } from "../odoo/capabilityService";
import { OdooRpcClient, OdooRpcError, SyncCredentials } from "../odoo/odooRpcClient";

/** Technical name of the server module that makes chat posts idempotent. */
export const CHAT_MODULE = "erplibre_mobile_chat";

/** Field the module adds to mail.message (1.0), discuss.channel (1.1) and ir.attachment (1.2). */
export const CHAT_UUID_FIELD = "erplibre_client_uuid";

/** ir.module.module is readable only with is_system, so the row is an admin-only signal. */
async function moduleRow(
  rpc: OdooRpcClient,
  creds: SyncCredentials
): Promise<{ id: number; state: string } | null> {
  const rows = await rpc.searchRead<{ id: number; state: string }>(
    creds,
    "ir.module.module",
    [["name", "=", CHAT_MODULE]],
    ["state"]
  );
  return rows[0] ?? null;
}

/** Module version as the fields it adds show it; null when none is visible. */
export type ChatModuleLevel = "1.0" | "1.1" | "1.2";

const LEVEL_RANK: Record<ChatModuleLevel, number> = { "1.0": 0, "1.1": 1, "1.2": 2 };

/** Whether the level reaches min; a null level (module unseen) is below every one. */
export function levelAtLeast(level: ChatModuleLevel | null, min: ChatModuleLevel): boolean {
  return level !== null && LEVEL_RANK[level] >= LEVEL_RANK[min];
}

/**
 * Module version from the (cached or fresh) capabilities, which any user can
 * read: CHAT_UUID_FIELD on ir.attachment is 1.2, on discuss.channel 1.1, on
 * mail.message 1.0; null when none carries it, or offline without a cached
 * capability. `fresh` skips the capability cache, as needed right after an
 * install or an upgrade.
 */
export async function moduleLevel(
  capabilities: CapabilityService,
  creds: SyncCredentials,
  opts: { online: boolean; fresh?: boolean }
): Promise<ChatModuleLevel | null> {
  const probe = { online: opts.online, maxAgeMs: opts.fresh ? 0 : undefined };
  const levels: Array<[string, ChatModuleLevel]> = [
    ["ir.attachment", "1.2"],
    ["discuss.channel", "1.1"],
    ["mail.message", "1.0"],
  ];
  for (const [model, level] of levels) {
    const capability = await capabilities.ensure(creds, model, probe);
    if (capability && CHAT_UUID_FIELD in (capability.fields ?? {})) return level;
  }
  return null;
}

/** Module state with the level it was read at. */
export type ModuleProbe = { state: ChatModuleState; level: ChatModuleLevel | null };

/**
 * State of the chat module on a server, with its level; it never persists
 * them.
 * - installed: the level is 1.2; or a system user sees the module row
 *   installed before the registry exposes any field;
 * - outdated: the level is 1.0 or 1.1 (the row of an older module reads
 *   installed until it is upgraded, so the level decides), or a system user
 *   sees the row waiting for an upgrade;
 * - available / absent: no level, and a system user sees the row not
 *   installed / no row;
 * - unknown: no level, and not a system user, or offline.
 */
export async function moduleProbe(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials,
  opts: { online: boolean; fresh?: boolean }
): Promise<ModuleProbe> {
  const level = await moduleLevel(capabilities, creds, opts);
  if (level) return { state: level === "1.2" ? "installed" : "outdated", level };
  if (!opts.online) return { state: "unknown", level };
  if (!(await rpc.sessionInfo(creds)).isSystem) return { state: "unknown", level };
  const row = await moduleRow(rpc, creds);
  if (!row) return { state: "absent", level };
  if (row.state === "to upgrade") return { state: "outdated", level };
  return { state: row.state === "installed" ? "installed" : "available", level };
}

/**
 * Level to act on for a stored source state. A row stored before the level
 * existed has none: its state then meant module 1.1 when installed and 1.0
 * when outdated, which the fallback keeps until the next probe stores the
 * real level.
 */
export function effectiveLevel(stored: {
  moduleState: ChatModuleState;
  moduleLevel: ChatModuleLevel | null;
}): ChatModuleLevel | null {
  if (stored.moduleLevel) return stored.moduleLevel;
  if (stored.moduleState === "installed") return "1.1";
  return stored.moduleState === "outdated" ? "1.0" : null;
}

/** The state half of moduleProbe. */
export async function moduleState(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials,
  opts: { online: boolean; fresh?: boolean }
): Promise<ChatModuleState> {
  return (await moduleProbe(rpc, capabilities, creds, opts)).state;
}

/**
 * Runs a module button (install or upgrade) on the module row, then returns
 * the freshly probed state and level. The button can outlast the transport timeout
 * while the work goes on server side, so a response lost to a transport
 * error is not a failure: the probe tells the outcome. An AccessError
 * refusal also returns the probed state; any other server error propagates.
 */
async function pressModuleButton(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials,
  button: string
): Promise<ModuleProbe> {
  const row = await moduleRow(rpc, creds);
  if (row) {
    try {
      await rpc.callKw(creds, "ir.module.module", button, [[row.id]]);
    } catch (e) {
      const refused = e instanceof OdooRpcError && /AccessError/.test(e.odooName ?? "");
      const lost = !(e instanceof OdooRpcError);
      if (!refused && !lost) throw e;
    }
  }
  return moduleProbe(rpc, capabilities, creds, { online: true, fresh: true });
}

/** Installs the module when the server lists it as available; returns the probed state and level. */
export async function installModule(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials
): Promise<ModuleProbe> {
  const before = await moduleProbe(rpc, capabilities, creds, { online: true, fresh: true });
  if (before.state !== "available") return before;
  return pressModuleButton(rpc, capabilities, creds, "button_immediate_install");
}

/**
 * Upgrades a module 1.0 or 1.1 to the current version; system users only, as the
 * module row is not readable otherwise. Any other state is returned as probed.
 */
export async function upgradeModule(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials
): Promise<ModuleProbe> {
  const before = await moduleProbe(rpc, capabilities, creds, { online: true, fresh: true });
  if (before.state !== "outdated" || !(await rpc.sessionInfo(creds)).isSystem) return before;
  return pressModuleButton(rpc, capabilities, creds, "button_immediate_upgrade");
}
