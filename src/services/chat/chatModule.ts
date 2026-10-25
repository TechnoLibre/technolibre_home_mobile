import { ChatModuleState } from "../../models/chat";
import { CapabilityService } from "../odoo/capabilityService";
import { OdooRpcClient, OdooRpcError, SyncCredentials } from "../odoo/odooRpcClient";

/** Technical name of the server module that makes chat posts idempotent. */
export const CHAT_MODULE = "erplibre_mobile_chat";

/** Field the module adds to mail.message; its presence means installed. */
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
 * - installed: mail.message carries CHAT_UUID_FIELD in the (cached or
 *   fresh) capability, which any user can read; or a system user sees the
 *   module row installed before the registry exposes the field;
 * - available / absent: a system user sees the row not installed / no row;
 * - unknown: not a system user, or offline without a cached capability.
 * Offline, only the cached capability is consulted. `fresh` skips the
 * capability cache, as needed right after an install.
 */
export async function moduleState(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials,
  opts: { online: boolean; fresh?: boolean }
): Promise<ChatModuleState> {
  const cap = await capabilities.ensure(creds, "mail.message", {
    online: opts.online,
    maxAgeMs: opts.fresh ? 0 : undefined,
  });
  if (cap && CHAT_UUID_FIELD in (cap.fields ?? {})) return "installed";
  if (!opts.online) return "unknown";
  if (!(await rpc.sessionInfo(creds)).isSystem) return "unknown";
  const row = await moduleRow(rpc, creds);
  if (!row) return "absent";
  return row.state === "installed" ? "installed" : "available";
}

/**
 * Installs the module when the server lists it as available, then returns
 * the freshly probed state. button_immediate_install can outlast the
 * transport timeout while the install goes on server side, so a response
 * lost to a transport error is not a failure: the probe tells the outcome.
 * An AccessError refusal also returns the probed state; any other server
 * error propagates.
 */
export async function installModule(
  rpc: OdooRpcClient,
  capabilities: CapabilityService,
  creds: SyncCredentials
): Promise<ChatModuleState> {
  const before = await moduleState(rpc, capabilities, creds, { online: true, fresh: true });
  if (before !== "available") return before;
  const row = await moduleRow(rpc, creds);
  if (!row) return "absent";
  try {
    await rpc.callKw(creds, "ir.module.module", "button_immediate_install", [[row.id]]);
  } catch (e) {
    const refused = e instanceof OdooRpcError && /AccessError/.test(e.odooName ?? "");
    const lost = !(e instanceof OdooRpcError);
    if (!refused && !lost) throw e;
  }
  return moduleState(rpc, capabilities, creds, { online: true, fresh: true });
}
