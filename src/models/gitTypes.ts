export interface GitCommit {
    sha: string;
    message: string;
    author: { name: string; email: string };
    /** ISO 8601 string. */
    date: string;
    parentShas: string[];
}

export interface GitStatus {
    modified: string[];
    untracked: string[];
    staged: string[];
    deleted: string[];
}

export type GitDiffLineType = "context" | "add" | "del";

export interface GitDiffLine {
    type: GitDiffLineType;
    content: string;
}

export interface GitDiffHunk {
    filepath: string;
    oldStart: number;
    newStart: number;
    lines: GitDiffLine[];
}
