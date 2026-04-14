import type { PluginListenerHandle } from "@capacitor/core";
import { SshPlugin } from "../plugins/sshPlugin";
import { Server } from "../models/server";

export interface DirEntry {
    name: string;
    type: "file" | "dir";
    path: string;
}

export interface GitCommit {
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    date: string;
}

export interface GitBranch {
    name: string;
    current: boolean;
}

/** Encode a UTF-8 string to base64 safely (handles non-Latin-1 chars). */
function toBase64(str: string): string {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/**
 * SSH-backed service for browsing source code and running git operations.
 * Wraps the singleton SshPlugin — do not use alongside other SSH operations.
 */
export class CodeService {
    // ── URL helpers ───────────────────────────────────────────────────────────

    /** Returns true if the string looks like a clonable git URL. */
    static isGitUrl(str: string): boolean {
        return /^https?:\/\//.test(str) || str.startsWith("git@");
    }

    /** Derive a filesystem-safe slug from a git URL. */
    private static _urlToSlug(url: string): string {
        return url
            .replace(/^https?:\/\//, "")
            .replace(/^git@/, "")
            .replace(/\.git$/, "")
            .replace(/[/:]/g, "-")
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .replace(/-+/g, "-")
            .slice(0, 60);
    }
    private _sshOpen = false;

    get isConnected(): boolean {
        return this._sshOpen;
    }

    async connect(server: Server): Promise<void> {
        const credential = server.authType === "password"
            ? server.password
            : server.privateKey;
        await SshPlugin.connect({
            host: server.host,
            port: server.port,
            username: server.username,
            authType: server.authType,
            credential,
            passphrase: server.passphrase || undefined,
        });
        this._sshOpen = true;
    }

    async disconnect(): Promise<void> {
        if (!this._sshOpen) return;
        try { await SshPlugin.disconnect(); } catch { /* ignore */ }
        this._sshOpen = false;
    }

    /** Run command, collect stdout lines (trimmed). */
    private async collect(
        command: string
    ): Promise<{ lines: string[]; exitCode: number }> {
        const lines: string[] = [];
        let listener: PluginListenerHandle | null = null;
        try {
            listener = await SshPlugin.addListener("sshOutput", (data) => {
                if (data.stream === "stdout") lines.push(data.line.trim());
            });
            const result = await SshPlugin.execute({ command });
            return { lines, exitCode: result.exitCode };
        } finally {
            if (listener) await listener.remove();
        }
    }

    /** Run command, collect both stdout and stderr (untrimmed). */
    private async collectAll(
        command: string
    ): Promise<{ lines: string[]; exitCode: number }> {
        const lines: string[] = [];
        let listener: PluginListenerHandle | null = null;
        try {
            listener = await SshPlugin.addListener("sshOutput", (data) => {
                lines.push(data.line);
            });
            const result = await SshPlugin.execute({ command });
            return { lines, exitCode: result.exitCode };
        } finally {
            if (listener) await listener.remove();
        }
    }

    // ── Streaming exec ───────────────────────────────────────────────────────

    /**
     * Execute a command and stream every output line (stdout + stderr) to a
     * callback. Returns the exit code.
     */
    async execStream(
        command: string,
        onLine: (line: string) => void,
    ): Promise<number> {
        let listener: PluginListenerHandle | null = null;
        try {
            listener = await SshPlugin.addListener("sshOutput", (data) => {
                onLine(data.line);
            });
            const { exitCode } = await SshPlugin.execute({ command });
            return exitCode;
        } finally {
            if (listener) await listener.remove();
        }
    }

    // ── Git URL — clone / pull ────────────────────────────────────────────────

    /**
     * Clone a remote git repo (https:// or git@) to a local cache path on the
     * server, or pull if it already exists.
     *
     * @param url  Remote git URL
     * @param onProgress  Called for each line of git clone/pull output
     * @returns  The absolute local path of the cloned repo
     */
    async cloneOrPull(
        url: string,
        onProgress: (line: string) => void,
    ): Promise<string> {
        const slug = CodeService._urlToSlug(url);

        // Resolve $HOME
        const { lines } = await this.collect("echo $HOME");
        const home = lines[0]?.trim() ?? "~";
        const cacheBase = `${home}/.cache/erplibre_code`;
        const localPath = `${cacheBase}/${slug}`;

        // Check if already cloned
        const { exitCode: existsCode } = await this.collect(
            `test -d "${localPath}/.git"`
        );

        if (existsCode === 0) {
            // Repo already cloned — pull latest
            onProgress(`→ Dépôt trouvé: ${localPath}`);
            onProgress("→ git pull en cours…");
            await this.execStream(
                `git -C "${localPath}" pull 2>&1`,
                onProgress,
            );
        } else {
            // First time — clone
            onProgress(`→ Clonage de: ${url}`);
            onProgress(`→ Destination: ${localPath}`);
            await this.collect(`mkdir -p "${cacheBase}"`);
            const exitCode = await this.execStream(
                `git clone "${url}" "${localPath}" 2>&1`,
                onProgress,
            );
            if (exitCode !== 0) {
                throw new Error("Clonage échoué. Vérifiez l'URL et les accès.");
            }
        }

        return localPath;
    }

    // ── Filesystem ────────────────────────────────────────────────────────────

    /**
     * List directory contents, excluding .git and node_modules.
     * Returns dirs first, then files, both sorted alphabetically.
     */
    async listDir(dirPath: string): Promise<DirEntry[]> {
        const cmd = [
            `find "${dirPath}" -maxdepth 1 -mindepth 1`,
            `! -name '.git' ! -name 'node_modules'`,
            `\\( -type f -printf 'f:%f\\n' -o -type d -printf 'd:%f\\n' \\)`,
            `2>/dev/null | sort`,
        ].join(" ");
        const { lines } = await this.collect(cmd);
        const dirs: DirEntry[] = [];
        const files: DirEntry[] = [];
        for (const line of lines) {
            if (line.length < 3) continue;
            const isDir = line.startsWith("d:");
            const isFile = line.startsWith("f:");
            if (!isDir && !isFile) continue;
            const name = line.slice(2);
            const entry: DirEntry = {
                name,
                type: isDir ? "dir" : "file",
                path: `${dirPath}/${name}`,
            };
            if (isDir) dirs.push(entry);
            else files.push(entry);
        }
        return [...dirs, ...files];
    }

    /**
     * Read file content as a raw base64 string (no UTF-8 decoding).
     * Useful for images and other binary files.
     */
    async readFileAsBase64(filePath: string): Promise<string> {
        const b64Lines: string[] = [];
        let listener: PluginListenerHandle | null = null;
        try {
            listener = await SshPlugin.addListener("sshOutput", (data) => {
                if (data.stream === "stdout") b64Lines.push(data.line.trim());
            });
            await SshPlugin.execute({ command: `base64 "${filePath}" 2>/dev/null` });
        } finally {
            if (listener) await listener.remove();
        }
        return b64Lines.join("");
    }

    /**
     * Read file content via base64 to safely handle UTF-8 and empty lines.
     * Returns the decoded string.
     */
    async readFile(filePath: string): Promise<string> {
        const b64 = await this.readFileAsBase64(filePath);
        if (!b64) return "";
        try {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new TextDecoder("utf-8").decode(bytes);
        } catch {
            return "";
        }
    }

    /**
     * Replace a single line in a file (1-based lineNum).
     * Uses Python3 with base64-encoded arguments to safely handle special chars.
     */
    async writeLine(filePath: string, lineNum: number, newContent: string): Promise<void> {
        const b64Path = toBase64(filePath);
        const b64Content = toBase64(newContent);
        const py = [
            `import base64`,
            `p=base64.b64decode('${b64Path}').decode('utf-8')`,
            `c=base64.b64decode('${b64Content}').decode('utf-8')`,
            `lines=open(p).readlines()`,
            `lines[${lineNum - 1}]=c+'\\n'`,
            `open(p,'w').writelines(lines)`,
        ].join(";");
        const { exitCode } = await this.collect(`python3 -c "${py}"`);
        if (exitCode !== 0) throw new Error(`Erreur écriture ligne ${lineNum}`);
    }

    // ── Git ───────────────────────────────────────────────────────────────────

    async gitCurrentBranch(repoPath: string): Promise<string> {
        const { lines } = await this.collect(
            `git -C "${repoPath}" rev-parse --abbrev-ref HEAD 2>/dev/null`
        );
        return lines[0]?.trim() || "inconnu";
    }

    async gitStatus(repoPath: string): Promise<string> {
        const { lines } = await this.collect(
            `git -C "${repoPath}" status --short 2>/dev/null`
        );
        return lines.join("\n").trim();
    }

    async gitLog(repoPath: string, limit = 25): Promise<GitCommit[]> {
        const { lines } = await this.collect(
            `git -C "${repoPath}" log --format="%H|%h|%s|%an|%ar" -n ${limit} 2>/dev/null`
        );
        return lines
            .filter((l) => l.includes("|"))
            .map((line) => {
                const parts = line.split("|");
                return {
                    hash: parts[0] ?? "",
                    shortHash: parts[1] ?? "",
                    subject: parts.slice(2, parts.length - 2).join("|"),
                    author: parts[parts.length - 2] ?? "",
                    date: parts[parts.length - 1] ?? "",
                };
            });
    }

    async gitBranches(repoPath: string): Promise<GitBranch[]> {
        const { lines } = await this.collect(
            `git -C "${repoPath}" branch 2>/dev/null`
        );
        return lines
            .filter((l) => l.trim())
            .map((line) => ({
                name: line.replace(/^\*\s*/, "").trim(),
                current: line.startsWith("*"),
            }));
    }

    async gitDiff(repoPath: string): Promise<string> {
        const { lines } = await this.collectAll(
            `git -C "${repoPath}" diff 2>/dev/null`
        );
        return lines.join("\n");
    }

    async gitCheckout(
        repoPath: string,
        ref: string
    ): Promise<{ output: string; exitCode: number }> {
        const { lines, exitCode } = await this.collectAll(
            `git -C "${repoPath}" checkout "${ref}" 2>&1`
        );
        return { output: lines.join("\n"), exitCode };
    }

    async gitCommit(
        repoPath: string,
        message: string
    ): Promise<{ output: string; exitCode: number }> {
        const b64Msg = toBase64(message);
        const cmd = [
            `git -C "${repoPath}" add -A`,
            `MSG=$(python3 -c "import base64; print(base64.b64decode('${b64Msg}').decode('utf-8'),end='')")`,
            `git -C "${repoPath}" commit -m "$MSG" 2>&1`,
        ].join(" && ");
        const { lines, exitCode } = await this.collectAll(cmd);
        return { output: lines.join("\n"), exitCode };
    }
}
