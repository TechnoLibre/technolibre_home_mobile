import { DatabaseService, RemoteRecord } from "../databaseService";
import { syncConfigIdFor } from "../../models/syncConfig";
import { OdooRpcClient, SyncCredentials } from "./odooRpcClient";

export const PARTNER_MODEL = "res.partner";

/** Records one search returns. */
export const RECORD_SEARCH_LIMIT = 20;
/** Records of one model kept in the cache per server, most recent first. */
export const RECORD_CACHE_KEEP = 200;

export interface RecordChoice {
  id: number;
  name: string;
}

export interface RecordSearch {
  records: RecordChoice[];
  /** The records come from the cache: offline, or the server did not answer. */
  fromCache: boolean;
  /** Why the server could not be searched, when it was tried. */
  error: string | null;
}

/** Lowercase, accents removed: how cached names are matched offline. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Searches the records of one model by name on a server (name_search,
 * the server's own display name and "ilike" matching) and keeps what it
 * found in remote_records_cache, at most RECORD_CACHE_KEEP per server, so
 * the same search works offline: offline, or when the server does not
 * answer, the cached names containing the text are returned instead.
 */
export class RecordSearchService {
  constructor(
    private db: DatabaseService,
    private rpc: OdooRpcClient,
    readonly model: string,
    private now: () => Date = () => new Date()
  ) {}

  async search(creds: SyncCredentials, text: string, options: { online: boolean }): Promise<RecordSearch> {
    const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
    let error: string | null = null;
    if (options.online) {
      try {
        const found = await this.rpc.nameSearch(creds, this.model, text.trim(), { limit: RECORD_SEARCH_LIMIT });
        await this.remember(configId, found);
        return { records: found, fromCache: false, error: null };
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const needle = fold(text.trim());
    const cached = (await this.db.getRemoteRecords(configId, this.model))
      .filter((r) => !needle || fold(r.displayName).includes(needle))
      .slice(0, RECORD_SEARCH_LIMIT)
      .map((r) => ({ id: r.resId, name: r.displayName }));
    return { records: cached, fromCache: true, error };
  }

  /** Puts records in the cache, as just seen. */
  async remember(configId: string, records: RecordChoice[]): Promise<void> {
    const fetchedAt = this.now().toISOString();
    const rows: RemoteRecord[] = records.map((r) => ({
      configId, model: this.model, resId: r.id, displayName: r.name, extra: {}, fetchedAt,
    }));
    await this.db.upsertRemoteRecords(configId, this.model, rows, RECORD_CACHE_KEEP);
  }
}
