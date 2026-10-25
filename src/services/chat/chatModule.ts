import { ChatModuleState } from "../../models/chat";
import { CapabilityService } from "../odoo/capabilityService";
import { OdooRpcClient, OdooRpcError, SyncCredentials } from "../odoo/odooRpcClient";

/** Technical name of the server module that makes chat posts idempotent. */
export const CHAT_MODULE = "erplibre_mobile_chat";

/** Field the module adds to mail.message (1.0) and discuss.channel (1.1). */
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

/**
 * State of the chat module on a server; it never persists it.
 * - installed: discuss.channel carries CHAT_UUID_FIELD (module 1.1) in the
 *   (cached or fresh) capability, which any user can read; or a system user
 *   sees the module row installed before the registry exposes any field;
 * - outdated: only mail.message carries it (module 1.0), or a system user
 *   sees the row waiting for an upgrade;
 * - available / absent: a system user sees the row not installed / no row;
 * - unknown: not a system user, or offline without a cached capability.
 * Offline, only the cached capabilities are consulted. `fresh` skips the
 * capability cache, as needed right after an install or an upgrade.
 */
export async function moduleState(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials,
  opts: { online: boolean; fresh?: boolean }
): Promise<ChatModuleState> {
  const probe = { online: opts.online, maxAgeMs: opts.fresh ? 0 : undefined };
  const channel = await capabilities.ensure(creds, "discuss.channel", probe);
  if (channel && CHAT_UUID_FIELD in (channel.fields ?? {})) return "installed";
  const message = await capabilities.ensure(creds, "mail.message", probe);
  if (message && CHAT_UUID_FIELD in (message.fields ?? {})) return "outdated";
  if (!opts.online) return "unknown";
  if (!(await rpc.sessionInfo(creds)).isSystem) return "unknown";
  const row = await moduleRow(rpc, creds);
  if (!row) return "absent";
  if (row.state === "to upgrade") return "outdated";
  return row.state === "installed" ? "installed" : "available";
}

/**
 * Runs a module button (install or upgrade) on the module row, then returns
 * the freshly probed state. The button can outlast the transport timeout
 * while the work goes on server side, so a response lost to a transport
 * error is not a failure: the probe tells the outcome. An AccessError
 * refusal also returns the probed state; any other server error propagates.
 */
async function pressModuleButton(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials,
  button: string
): Promise<ChatModuleState> {
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
  return moduleState(rpc, capabilities, creds, { online: true, fresh: true });
}

/** Installs the module when the server lists it as available; returns the probed state. */
export async function installModule(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials
): Promise<ChatModuleState> {
  const before = await moduleState(rpc, capabilities, creds, { online: true, fresh: true });
  if (before !== "available") return before;
  return pressModuleButton(rpc, capabilities, creds, "button_immediate_install");
}

/**
 * Upgrades a module 1.0 to the current version; system users only, as the
 * module row is not readable otherwise. Any other state is returned as probed.
 */
export async function upgradeModule(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials
): Promise<ChatModuleState> {
  const before = await moduleState(rpc, capabilities, creds, { online: true, fresh: true });
  if (before !== "outdated" || !(await rpc.sessionInfo(creds)).isSystem) return before;
  return pressModuleButton(rpc, capabilities, creds, "button_immediate_upgrade");
}
