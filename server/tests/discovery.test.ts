import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGitRepositories } from "../src/services/ProjectDiscoveryService.js";
import { makeTempDir, writeFakeGitDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Project discovery", () => {
  it("discovers the scan root when it is a Git repository", () => {
    const root = makeTempDir("ldd-scan-");
    dirs.push(root);
    writeFakeGitDir(root);
    expect(findGitRepositories(root, 3)).toEqual([
      expect.stringMatching(new RegExp(path.basename(root) + "$", "i")),
    ]);
  });

  it("respects scan depth", () => {
    const root = makeTempDir("ldd-scan-");
    dirs.push(root);
    writeFakeGitDir(path.join(root, "a"));
    writeFakeGitDir(path.join(root, "d", "e", "f"));
    writeFakeGitDir(path.join(root, "d", "e", "f", "g"));

    const depth1 = findGitRepositories(root, 1).map((p) => p.toLowerCase());
    expect(depth1.some((p) => p.endsWith("\\a"))).toBe(true);
    expect(depth1.some((p) => p.endsWith("\\f"))).toBe(false);

    const depth3 = findGitRepositories(root, 3).map((p) => p.toLowerCase());
    expect(depth3.some((p) => p.endsWith("\\a"))).toBe(true);
    expect(depth3.some((p) => p.endsWith("\\f"))).toBe(true);
    expect(depth3.some((p) => p.endsWith("\\g"))).toBe(false);
  });

  it("skips excluded directories", () => {
    const root = makeTempDir("ldd-scan-");
    dirs.push(root);
    writeFakeGitDir(path.join(root, "keep"));
    writeFakeGitDir(path.join(root, "node_modules", "hidden"));
    writeFakeGitDir(path.join(root, "vendor", "hidden"));
    writeFakeGitDir(path.join(root, "dist", "hidden"));
    writeFakeGitDir(path.join(root, "build", "hidden"));
    writeFakeGitDir(path.join(root, ".venv", "hidden"));

    const found = findGitRepositories(root, 3).map((p) => p.toLowerCase());
    expect(found.some((p) => p.endsWith("\\keep"))).toBe(true);
    expect(found.some((p) => p.includes("\\node_modules\\"))).toBe(false);
    expect(found.some((p) => p.includes("\\vendor\\"))).toBe(false);
    expect(found.some((p) => p.includes("\\dist\\"))).toBe(false);
  });

  it("survives inaccessible directories without failing the scan", () => {
    const root = makeTempDir("ldd-scan-");
    dirs.push(root);
    writeFakeGitDir(path.join(root, "visible"));
    const fileAsDirParent = path.join(root, "blocked");
    fs.writeFileSync(fileAsDirParent, "not a directory");
    const found = findGitRepositories(root, 3);
    expect(found.length).toBe(1);
  });

  it("does not report duplicate identities for the same repository", () => {
    const root = makeTempDir("ldd-scan-");
    dirs.push(root);
    writeFakeGitDir(path.join(root, "app"));
    const found = findGitRepositories(root, 3);
    expect(found).toHaveLength(1);
  });
});
