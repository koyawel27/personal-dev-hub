import { describe, expect, it } from "vitest";
import {
  parseAheadBehind,
  parseLog,
  parsePorcelain,
  parseRemotes,
} from "../src/lib/gitParse.js";
import { GIT_OPERATIONS, isFrozenGitArgv } from "../src/lib/gitRunner.js";

describe("Git output parsing", () => {
  it("parses a clean working tree", () => {
    expect(parsePorcelain("")).toEqual({
      isDirty: false,
      modifiedCount: 0,
      stagedCount: 0,
      untrackedCount: 0,
      changedFiles: [],
    });
  });

  it("counts modified, staged, and untracked files", () => {
    const output = [
      " M src/app.ts",
      "M  src/index.ts",
      "MM src/both.ts",
      "?? loose.txt",
      "R  old.ts -> new.ts",
      " D gone.ts",
    ].join("\n");
    const parsed = parsePorcelain(output);
    expect(parsed.modifiedCount).toBe(3);
    expect(parsed.stagedCount).toBe(3);
    expect(parsed.untrackedCount).toBe(1);
    expect(parsed.isDirty).toBe(true);
    expect(parsed.changedFiles.map((file) => file.kind)).toEqual([
      "modified",
      "staged",
      "staged",
      "untracked",
      "renamed",
      "deleted",
    ]);
  });

  it("parses remotes, preferring fetch URLs", () => {
    const output = [
      "origin  https://github.com/acme/widgets.git (fetch)",
      "origin  https://github.com/acme/widgets.git (push)",
      "upstream  git@gitlab.com:acme/widgets.git (fetch)",
    ].join("\n");
    expect(parseRemotes(output)).toEqual([
      { name: "origin", url: "https://github.com/acme/widgets.git" },
      { name: "upstream", url: "git@gitlab.com:acme/widgets.git" },
    ]);
  });

  it("parses ahead/behind from rev-list left-right counts", () => {
    expect(parseAheadBehind("2\t5")).toEqual({ behind: 2, ahead: 5 });
    expect(parseAheadBehind("0 0")).toEqual({ behind: 0, ahead: 0 });
    expect(parseAheadBehind("bogus")).toBeNull();
  });

  it("parses commit log records", () => {
    const line = [
      "abc123def",
      "abc123d",
      "Fix dashboard scan",
      "Dev",
      "2026-08-21T10:00:00+08:00",
    ].join("\x1f");
    expect(parseLog(line)).toEqual([
      {
        sha: "abc123def",
        shortSha: "abc123d",
        subject: "Fix dashboard scan",
        authorName: "Dev",
        committedAt: "2026-08-21T10:00:00+08:00",
      },
    ]);
  });
});

describe("Frozen Git argv", () => {
  it("only allows the named read-only operations", () => {
    expect(isFrozenGitArgv(GIT_OPERATIONS.status)).toBe(true);
    expect(isFrozenGitArgv(["fetch"])).toBe(false);
    expect(isFrozenGitArgv(["pull"])).toBe(false);
    expect(isFrozenGitArgv(["status"])).toBe(false);
    expect(isFrozenGitArgv(["-c", "alias.x=!touch pwned", "x"])).toBe(false);
  });
});
