import { DatabaseService, RemoteRecord } from "../databaseService";
import { syncConfigIdFor } from "../../models/syncConfig";
import { OdooRpcClient, SyncCredentials } from "./odooRpcClient";

export const PROJECT_MODEL = "project.project";

/** Projects one list() reads; a server with more says so through truncated. */
export const PROJECT_LIST_LIMIT = 500;

export interface ProjectChoice {
  id: number;
  name: string;
}

export interface ProjectList {
  projects: ProjectChoice[];
  /** The list comes from the cache: offline, or the server did not answer. */
  fromCache: boolean;
  /** When the projects were read from the server; null when never. */
  fetchedAt: string | null;
  /** The server returned PROJECT_LIST_LIMIT projects: some may be missing. */
  truncated: boolean;
  /** Why the server could not be read, when it was tried. */
  error: string | null;
}

/**
 * The projects a new task can go to, per server. Online, list() reads the
 * active projects the user can see and replaces that server's cached list
 * in remote_records_cache; offline, or when the server does not answer, it
 * serves the cached list, which may be empty.
 */
export class ProjectService {
  constructor(
    private db: DatabaseService,
    private rpc: OdooRpcClient,
    private now: () => Date = () => new Date()
  ) {}

  async list(creds: SyncCredentials, options: { online: boolean }): Promise<ProjectList> {
    const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
    let error: string | null = null;
    if (options.online) {
      try {
        const rows = await this.rpc.searchRead<{ id: number; name: string }>(
          creds, PROJECT_MODEL, [], ["id", "name"], { order: "name asc", limit: PROJECT_LIST_LIMIT }
        );
        const fetchedAt = this.now().toISOString();
        const records: RemoteRecord[] = rows.map((r) => ({
          configId, model: PROJECT_MODEL, resId: r.id, displayName: String(r.name ?? `#${r.id}`),
          extra: {}, fetchedAt,
        }));
        await this.db.replaceRemoteRecords(configId, PROJECT_MODEL, records);
        return {
          projects: records.map(toChoice),
          fromCache: false,
          fetchedAt,
          truncated: rows.length >= PROJECT_LIST_LIMIT,
          error: null,
        };
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const cached = await this.db.getRemoteRecords(configId, PROJECT_MODEL);
    return {
      projects: cached.map(toChoice),
      fromCache: true,
      fetchedAt: cached.length > 0 ? cached.map((r) => r.fetchedAt).sort()[0] : null,
      truncated: cached.length >= PROJECT_LIST_LIMIT,
      error,
    };
  }
}

function toChoice(r: RemoteRecord): ProjectChoice {
  return { id: r.resId, name: r.displayName };
}
