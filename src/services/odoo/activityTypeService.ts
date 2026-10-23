import { DatabaseService, RemoteRecord } from "../databaseService";
import { syncConfigIdFor } from "../../models/syncConfig";
import { OdooRpcClient, SyncCredentials } from "./odooRpcClient";

export const ACTIVITY_TYPE_MODEL = "mail.activity.type";

/** Types one list() reads. */
export const ACTIVITY_TYPE_LIST_LIMIT = 200;

/**
 * One activity type of a server: the model it is restricted to (null: any
 * model) and the delay its activities default to. delayFrom is where the
 * server counts it from: the day the activity is scheduled
 * ("current_date"), or the deadline of the activity just marked done
 * ("previous_activity", the server's default), which falls back to the
 * scheduling day for an activity scheduled on its own.
 */
export interface ActivityTypeChoice {
  id: number;
  name: string;
  resModel: string | null;
  delayCount: number;
  delayUnit: "days" | "weeks" | "months";
  delayFrom: string;
}

export interface ActivityTypeList {
  types: ActivityTypeChoice[];
  /** The list comes from the cache: offline, or the server did not answer. */
  fromCache: boolean;
  /** Why the server could not be read, when it was tried. */
  error: string | null;
}

/** The types offered for an activity on model: those for any model or for it. */
export function typesForModel(types: ActivityTypeChoice[], model: string): ActivityTypeChoice[] {
  return types.filter((t) => !t.resModel || t.resModel === model);
}

/**
 * "YYYY-MM-DD" of today plus a type's delay, in the device's time zone, as
 * the server computes it for an activity scheduled from a note: there is
 * no previous activity, so delayFrom makes no difference.
 */
export function defaultDeadline(type: ActivityTypeChoice | null, today: Date): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (type && type.delayCount > 0) {
    if (type.delayUnit === "months") d.setMonth(d.getMonth() + type.delayCount);
    else d.setDate(d.getDate() + type.delayCount * (type.delayUnit === "weeks" ? 7 : 1));
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The activity types of a server. Online, list() reads the active types
 * (search_read on mail.activity.type, readable by every internal user)
 * and replaces that server's cached list in remote_records_cache, the
 * restriction and delay in extra; offline, or when the server does not
 * answer, it serves the cached list, which may be empty.
 */
export class ActivityTypeService {
  constructor(
    private db: DatabaseService,
    private rpc: OdooRpcClient,
    private now: () => Date = () => new Date()
  ) {}

  async list(creds: SyncCredentials, options: { online: boolean }): Promise<ActivityTypeList> {
    const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
    let error: string | null = null;
    if (options.online) {
      try {
        const rows = await this.rpc.searchRead<any>(
          creds, ACTIVITY_TYPE_MODEL, [],
          ["id", "name", "res_model", "delay_count", "delay_unit", "delay_from"],
          { order: "sequence asc, id asc", limit: ACTIVITY_TYPE_LIST_LIMIT }
        );
        const fetchedAt = this.now().toISOString();
        const records: RemoteRecord[] = rows.map((r) => ({
          configId, model: ACTIVITY_TYPE_MODEL, resId: r.id, displayName: String(r.name ?? `#${r.id}`),
          extra: {
            resModel: r.res_model || null,
            delayCount: Number(r.delay_count) || 0,
            delayUnit: r.delay_unit ?? "days",
            delayFrom: r.delay_from ?? "current_date",
          },
          fetchedAt,
        }));
        await this.db.replaceRemoteRecords(configId, ACTIVITY_TYPE_MODEL, records);
        return { types: records.map(toChoice), fromCache: false, error: null };
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const cached = await this.db.getRemoteRecords(configId, ACTIVITY_TYPE_MODEL);
    return { types: cached.map(toChoice), fromCache: true, error };
  }
}

function toChoice(r: RemoteRecord): ActivityTypeChoice {
  const unit = r.extra.delayUnit;
  return {
    id: r.resId,
    name: r.displayName,
    resModel: r.extra.resModel ?? null,
    delayCount: Number(r.extra.delayCount) || 0,
    delayUnit: unit === "weeks" || unit === "months" ? unit : "days",
    delayFrom: r.extra.delayFrom ?? "current_date",
  };
}
