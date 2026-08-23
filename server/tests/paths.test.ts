import { describe, expect, it } from "vitest";
import {
  canonicalizePath,
  pathIdentity,
  repositoryNameFromPath,
  stripPathQuotes,
} from "../../shared/paths.js";

describe("Windows path normalization", () => {
  it("strips wrapping quotes", () => {
    expect(stripPathQuotes('"C:\\xampp-projects"')).toBe("C:\\xampp-projects");
    expect(stripPathQuotes("'C:\\xampp-projects'")).toBe("C:\\xampp-projects");
  });

  it("collapses slash style, trailing separators, and drive-letter case", () => {
    const a = pathIdentity("C:\\xampp-projects\\app");
    const b = pathIdentity("C:/xampp-projects/app/");
    const c = pathIdentity("c:\\xampp-projects\\app\\");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("treats equivalent path forms as one identity", () => {
    expect(pathIdentity("C:\\Foo\\Bar")).toBe(pathIdentity("c:/Foo/Bar/"));
  });

  it("uppercases the drive letter in the readable form", () => {
    expect(canonicalizePath("c:\\Temp\\Demo")).toMatch(/^C:\\/);
  });

  it("derives the repository name from the leaf folder", () => {
    expect(repositoryNameFromPath("C:\\xampp-projects\\local-dev-dashboard")).toBe(
      "local-dev-dashboard",
    );
  });
});
