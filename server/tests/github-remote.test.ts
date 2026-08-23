import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "../../shared/github-remote.js";

describe("GitHub remote parsing", () => {
  it("parses HTTPS GitHub remotes", () => {
    expect(parseGitHubRemote("https://github.com/acme/widgets.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repository: "widgets",
      htmlUrl: "https://github.com/acme/widgets",
    });
  });

  it("parses SSH GitHub remotes", () => {
    expect(parseGitHubRemote("git@github.com:acme/widgets.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repository: "widgets",
      htmlUrl: "https://github.com/acme/widgets",
    });
  });

  it("does not classify non-GitHub remotes as GitHub", () => {
    expect(parseGitHubRemote("https://gitlab.com/acme/widgets.git")).toBeNull();
    expect(parseGitHubRemote("git@bitbucket.org:acme/widgets.git")).toBeNull();
  });

  it("returns null for malformed remotes", () => {
    expect(parseGitHubRemote("")).toBeNull();
    expect(parseGitHubRemote("not a remote")).toBeNull();
    expect(parseGitHubRemote("https://github.com/acme")).toBeNull();
    expect(parseGitHubRemote("https://github.com/acme/widgets/issues")).toBeNull();
    expect(parseGitHubRemote("git@github.com:../etc/passwd.git")).toBeNull();
  });
});
