import { DatabaseService, ServerCapability } from "../databaseService";
import { syncConfigIdFor } from "../../models/syncConfig";
import { OdooRpcClient, OdooRpcError, SyncCredentials } from "./odooRpcClient";

/** Age past which ensure() probes again when online. */
export const CAPABILITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** What an operation needs from a model. */
export type CapabilityNeed = "read" | "create" | "write" | "activities" | "chatter";

/**
 * Why a model cannot serve an operation on a server, or null when it can:
 * - unknown: never probed (offline on first use);
 * - missing_model: the model does not exist (module not installed);
 * - no_access: the user lacks the model-level right;
 * - no_activities / no_chatter: the model has no activity_ids / message_ids.
 * An access flag the server did not answer (null) does not block: the
 * server decides when the operation runs.
 */
export type UnusableReason = "unknown" | "missing_model" | "no_access" | "no_activities" | "no_chatter";

export function unusableReason(cap: ServerCapability | null, needs: CapabilityNeed[]): UnusableReason | null {
  if (!cap) return "unknown";
  if (!cap.exists) return "missing_model";
  for (const need of needs) {
    if (need === "read" && cap.canRead === false) return "no_access";
    if (need === "create" && cap.canCreate === false) return "no_access";
    if (need === "write" && cap.canWrite === false) return "no_access";
    if (need === "activities" && !cap.hasActivities) return "no_activities";
    if (need === "chatter" && !cap.hasChatter) return "no_chatter";
  }
  return null;
}

/**
 * Probes what a server allows on a model, through the standard API only,
 * and caches the answer per server in server_capabilities so it can be
 * checked offline. Never reads ir.model, which an ordinary internal user
 * cannot read on Odoo 17 and 18:
 * - existence and fields: fields_get, which answers KeyError on an
 *   unknown model;
 * - rights: OdooRpcClient.checkAccess for read, create and write;
 * - activities and chatter: activity_ids and message_ids among the fields.
 *
 * The cache can be stale (module uninstalled, rights changed): an
 * operation is validated again by the server when it runs.
 */
export class CapabilityService {
  constructor(
    private db: DatabaseService,
    private rpc: OdooRpcClient,
    private now: () => Date = () => new Date()
  ) {}

  /**
   * Probes model on the server and stores the result. A model the server
   * does not know (call_kw answers KeyError) is stored as exists=false
   * with the server's message; a fields_get refused with AccessError as an
   * existing model with no right. Any other failure — network, HTTP, a
   * server error raised for another reason — is thrown and leaves the
   * cache as it was.
   */
  async probe(creds: SyncCredentials, model: string): Promise<ServerCapability> {
    const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
    const odooVersion = await this.rpc.odooVersion(creds);
    const base: ServerCapability = {
      configId, model, exists: false,
      canRead: null, canCreate: null, canWrite: null,
      hasActivities: false, hasChatter: false,
      fields: {}, odooVersion, probedAt: this.now().toISOString(), error: null,
    };
    let fields: Record<string, any>;
    try {
      fields = await this.rpc.fieldsGet(creds, model);
    } catch (e: unknown) {
      if (!(e instanceof OdooRpcError)) throw e;
      const denied = e.odooName === "odoo.exceptions.AccessError";
      if (!denied && e.odooName !== "builtins.KeyError") throw e;
      const cap: ServerCapability = denied
        ? { ...base, exists: true, canRead: false, canCreate: false, canWrite: false, error: e.message }
        : { ...base, error: e.message };
      await this.db.setServerCapability(cap);
      return cap;
    }
    const cap: ServerCapability = {
      ...base,
      exists: true,
      canRead: await this.rpc.checkAccess(creds, model, "read"),
      canCreate: await this.rpc.checkAccess(creds, model, "create"),
      canWrite: await this.rpc.checkAccess(creds, model, "write"),
      hasActivities: "activity_ids" in (fields ?? {}),
      hasChatter: "message_ids" in (fields ?? {}),
      fields: fields ?? {},
    };
    await this.db.setServerCapability(cap);
    return cap;
  }

  /** The cached probe, however old, or null. */
  async cached(configId: string, model: string): Promise<ServerCapability | null> {
    return this.db.getServerCapability(configId, model);
  }

  /**
   * The cached probe while younger than maxAgeMs; otherwise a new probe
   * when online, or the stale cache (null if none) when offline or when
   * the probe cannot reach the server.
   */
  async ensure(
    creds: SyncCredentials,
    model: string,
    options: { online: boolean; maxAgeMs?: number }
  ): Promise<ServerCapability | null> {
    const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
    const cached = await this.cached(configId, model);
    const maxAge = options.maxAgeMs ?? CAPABILITY_MAX_AGE_MS;
    const fresh = cached && this.now().getTime() - new Date(cached.probedAt).getTime() < maxAge;
    if (fresh || !options.online) return cached;
    try {
      return await this.probe(creds, model);
    } catch {
      return cached;
    }
  }
}
