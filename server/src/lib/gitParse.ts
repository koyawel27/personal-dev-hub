import type { ChangedFile } from "../../../shared/api-types.js";

export type WorkingTreeStatus = {
  isDirty: boolean;
  modifiedCount: number;
  stagedCount: number;
  untrackedCount: number;
  changedFiles: ChangedFile[];
};

export type ParsedRemote = {
  name: string;
  url: string;
};

export type ParsedCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  committedAt: string;
};

function unquoteGitPath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return p;
}

function kindFromStatus(
  x: string,
  y: string,
  renamed: boolean,
): ChangedFile["kind"] {
  if (x === "?" && y === "?") return "untracked";
  if (renamed || x === "R" || y === "R") return "renamed";
  if (x === "D" || y === "D") return "deleted";
  if (x !== " " && x !== "?") return "staged";
  return "modified";
}

export function parsePorcelain(output: string): WorkingTreeStatus {
  const lines = output.split(/\r?\n/).filter((line) => line.length >= 2);
  let modifiedCount = 0;
  let stagedCount = 0;
  let untrackedCount = 0;
  const changedFiles: ChangedFile[] = [];

  for (const line of lines) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    const rest = line.slice(3);
    const renamed = rest.includes(" -> ");
    const filePath = renamed
      ? unquoteGitPath(rest.split(" -> ").pop() ?? rest)
      : unquoteGitPath(rest);

    if (x === "?" && y === "?") {
      untrackedCount += 1;
    } else {
      if (x !== " " && x !== "?") stagedCount += 1;
      if (y !== " " && y !== "?") modifiedCount += 1;
    }

    changedFiles.push({
      path: filePath,
      indexStatus: x,
      workTreeStatus: y,
      kind: kindFromStatus(x, y, renamed),
    });
  }

  return {
    isDirty: stagedCount + modifiedCount + untrackedCount > 0,
    modifiedCount,
    stagedCount,
    untrackedCount,
    changedFiles,
  };
}

export function parseRemotes(output: string): ParsedRemote[] {
  const byName = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    if (!byName.has(name) || kind === "fetch") {
      byName.set(name, url);
    }
  }
  return [...byName.entries()].map(([name, url]) => ({ name, url }));
}

export function parseAheadBehind(output: string): {
  behind: number;
  ahead: number;
} | null {
  const trimmed = output.trim();
  const match = trimmed.match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

export function parseLog(output: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\x1f");
    if (parts.length < 5) continue;
    const [sha, shortSha, subject, authorName, committedAt] = parts;
    if (!sha) continue;
    commits.push({
      sha,
      shortSha: shortSha || sha.slice(0, 7),
      subject: subject || "(no subject)",
      authorName: authorName || "",
      committedAt: committedAt || "",
    });
  }
  return commits;
}
