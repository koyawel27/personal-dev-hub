// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectDetailDto,
  ProjectLocalBindingDto,
  SnapshotDto,
} from "../../shared/api-types.js";

/**
 * V1.2 M3 — Local Copies panel UI on Project Detail.
 *
 * Gates under test:
 * - Project Detail renders EVERY local binding from the server-authoritative
 *   read model with exactly one Primary indicator, and each row's health/
 *   snapshot belongs to the correct binding (gate 12).
 * - Make primary reuses the existing set-primary endpoint, reloads, and the
 *   refreshed server payload alone decides the new top-level primary state
 *   and binding order — no client row-order heuristic (gate 13).
 * - Add Local Copy drives the native folder picker and the project-targeted
 *   attach endpoint; the LOCAL_BINDING_CONFIRM_REQUIRED ladder surfaces the
 *   server's evidence summary and retries with confirmUnverified=true only
 *   after explicit owner consent; cancelling changes nothing; errors never
 *   fake success (gate 14).
 * - Per-binding Rescan buttons target the correct binding id (gate 15, UI
 *   side; the server contract is covered in local-binding-attach.test.ts).
 * - GITHUB ONLY projects render the empty bindings panel with the Add local
 *   copy affordance (gate 17).
 * - Authority correction (post-M3 review): Project Detail resolves its
 *   display primary from project.localBindings alone — `client.repositories`
 *   is absent from the page's mock, and header launcher/rescan actions are
 *   proven to follow the reloaded isPrimary payload after Make primary.
 * - Cheap gate completions: native picker cancel attaches nothing and fakes
 *   no success; per-binding Remove passes the clicked binding's repository
 *   id (never the primary's) into the existing M1 removal flow.
 */

const { clientMocks, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.code = code;
      this.status = status;
    }
  }
  // NOTE: `repositories` is deliberately ABSENT — Project Detail must never
  // depend on GET /api/repositories (V1.2 M3 authority correction). Any
  // accidental call fails loudly as "not a function".
  const clientMocks = {
    project: vi.fn(),
    githubPicker: vi.fn(),
    activity: vi.fn(),
    selectFolder: vi.fn(),
    addLocalBinding: vi.fn(),
    setLocalPrimary: vi.fn(),
    refresh: vi.fn(),
    open: vi.fn(),
    deleteRepository: vi.fn(),
    updateProjectMetadata: vi.fn(),
    untrackGithub: vi.fn(),
    refreshTrackedGithub: vi.fn(),
  };
  return { clientMocks, MockApiError };
});

vi.mock("../../client/src/api.js", () => ({
  ApiError: MockApiError,
  client: clientMocks,
}));

import { ProjectDetailPage } from "../../client/src/pages/ProjectDetailPage.js";

// --- fixtures -----------------------------------------------------------------

let projectState: ProjectDetailDto;

function snapshotFixture(partial: Partial<SnapshotDto> = {}): SnapshotDto {
  return {
    branch: "main",
    headCommitSha: "9f2c1ab7d3e4f5061728394a5b6c7d8e9f0a1b2c",
    isDirty: false,
    modifiedCount: 0,
    stagedCount: 0,
    untrackedCount: 0,
    upstreamRef: "origin/main",
    aheadCount: 0,
    behindCount: 0,
    capturedAt: "2026-09-01T12:00:00.000Z",
    ...partial,
  };
}

function bindingFixture(
  partial: Partial<ProjectLocalBindingDto> & { id: number; localPath: string },
): ProjectLocalBindingDto {
  return {
    isPrimary: false,
    name: "copy",
    canonicalPath: partial.localPath.toLowerCase(),
    discoveryType: "manual",
    sourceId: null,
    lastScannedAt: "2026-09-01T12:00:00.000Z",
    snapshot: snapshotFixture(),
    health: { state: "OK", checkedAt: "2026-09-01T12:00:00.000Z" },
    ...partial,
  };
}

function projectFixture(partial: Partial<ProjectDetailDto>): ProjectDetailDto {
  return {
    id: 42,
    name: "Demo Project",
    sourceState: "LOCAL ONLY",
    projectStatus: null,
    projectType: null,
    includeInPortfolio: false,
    portfolioOrder: null,
    localPath: null,
    githubFullName: null,
    githubHtmlUrl: null,
    lastMeaningfulAt: null,
    projectNote: null,
    snapshot: null,
    localBindings: [],
    githubMetadata: null,
    commits: [],
    ...partial,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/42"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function row(container: HTMLElement, bindingId: number): HTMLElement {
  const el = container.querySelector(`[data-testid="local-binding-${bindingId}"]`);
  if (!el) throw new Error(`binding row ${bindingId} not rendered`);
  return el as HTMLElement;
}

/** List-scoped lookups: primary paths also appear in the header lede. */
function bindingsList(container: HTMLElement): HTMLElement {
  const el = container.querySelector("ul.bindings-list");
  if (!el) throw new Error("bindings list not rendered");
  return el as HTMLElement;
}

/** The page-header action cluster (distinct from per-binding row actions). */
function headerActions(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".page-header .header-actions");
  if (!el) throw new Error("page header actions not rendered");
  return el as HTMLElement;
}

beforeEach(() => {
  for (const fn of Object.values(clientMocks)) fn.mockReset();
  clientMocks.project.mockImplementation(() =>
    Promise.resolve({ project: projectState }),
  );
  clientMocks.githubPicker.mockResolvedValue({ entries: [] });
  clientMocks.activity.mockResolvedValue({ activity: [] });
  clientMocks.open.mockResolvedValue({});
  clientMocks.deleteRepository.mockResolvedValue({ ok: true, projectDeleted: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- gate 12: every binding rendered, one Primary, per-binding health/snapshot ---

describe("Local Copies panel rendering", () => {
  it("renders every binding with exactly one Primary tag and per-binding health/snapshot", async () => {
    const primary = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    const secondary = bindingFixture({
      id: 2,
      localPath: "C:\\work\\beta",
      snapshot: snapshotFixture({
        branch: "feature",
        headCommitSha: "aabbccdd00112233445566778899aabbccddeeff",
        isDirty: true,
        modifiedCount: 2,
        stagedCount: 1,
        untrackedCount: 3,
        upstreamRef: null,
      }),
      health: { state: "PATH_MISSING", checkedAt: null },
    });
    projectState = projectFixture({
      localBindings: [primary, secondary],
      snapshot: primary.snapshot,
      localPath: primary.localPath,
    });
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    expect(within(bindingsList(container)).getByText("C:\\work\\alpha")).toBeTruthy();
    expect(within(bindingsList(container)).getByText("C:\\work\\beta")).toBeTruthy();
    // Exactly one display-primary indicator across the whole panel.
    expect(screen.getAllByText("Primary")).toHaveLength(1);

    // Each row's snapshot/health belongs to the CORRECT binding.
    const rowA = row(container, 1);
    const rowB = row(container, 2);
    expect(within(rowA).getByText("main")).toBeTruthy();
    expect(within(rowA).getByText("Clean")).toBeTruthy();
    expect(within(rowA).getByText(/Last scanned/)).toBeTruthy();
    expect(within(rowB).getByText("feature")).toBeTruthy();
    expect(within(rowB).getByText("Uncommitted")).toBeTruthy();
    expect(within(rowB).getByText("Path missing")).toBeTruthy();

    // Make primary is offered only on non-primary rows (M3-I).
    expect(within(rowB).getByRole("button", { name: "Make primary" })).toBeTruthy();
    expect(within(rowA).queryByRole("button", { name: "Make primary" })).toBeNull();
  });

  it("per-binding Rescan targets that binding's repository id (gate 15, UI side)", async () => {
    const primary = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    const secondary = bindingFixture({ id: 2, localPath: "C:\\work\\beta" });
    projectState = projectFixture({
      localBindings: [primary, secondary],
      snapshot: primary.snapshot,
      localPath: primary.localPath,
    });
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    fireEvent.click(within(row(container, 2)).getByRole("button", { name: "Rescan" }));

    await waitFor(() => expect(clientMocks.refresh).toHaveBeenCalledWith(2));
  });
});

// --- gate 13: Make primary UI ----------------------------------------------------

describe("Make primary UI", () => {
  it("uses the existing endpoint and the reloaded server state alone becomes authoritative", async () => {
    const alpha = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    const beta = bindingFixture({ id: 2, localPath: "C:\\work\\beta" });
    projectState = projectFixture({
      localBindings: [alpha, beta],
      snapshot: alpha.snapshot,
      localPath: alpha.localPath,
    });
    // The mock simulates the server commit: the reloaded detail flips row
    // order, primary flag, AND the top-level primary fields in one payload.
    clientMocks.setLocalPrimary.mockImplementation(async () => {
      const nextBeta = bindingFixture({ id: 2, localPath: "C:\\work\\beta", isPrimary: true });
      const nextAlpha = bindingFixture({ id: 1, localPath: "C:\\work\\alpha" });
      projectState = projectFixture({
        localBindings: [nextBeta, nextAlpha],
        snapshot: nextBeta.snapshot,
        localPath: nextBeta.localPath,
      });
      return { primaryRepositoryId: 2 };
    });
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    fireEvent.click(within(row(container, 2)).getByRole("button", { name: "Make primary" }));

    await waitFor(() => expect(clientMocks.setLocalPrimary).toHaveBeenCalledWith(2));

    // After reload: the Primary tag moved to row 2 with the server's order.
    await waitFor(() => {
      expect(within(row(container, 2)).getByText("Primary")).toBeTruthy();
      expect(within(row(container, 1)).queryByText("Primary")).toBeNull();
    });
    expect(screen.getAllByText("Primary")).toHaveLength(1);
    // Top-level primary state follows the newly selected binding.
    expect(container.querySelector("p.lede.mono")?.textContent).toContain("C:\\work\\beta");

    // Header launcher/rescan actions now target binding B — derived solely
    // from the reloaded ProjectDetailDto (client.repositories does not even
    // exist on this page's mock, so no second authority could intervene).
    const header = headerActions(container);
    fireEvent.click(within(header).getByRole("button", { name: "Open Folder" }));
    await waitFor(() => expect(clientMocks.open).toHaveBeenCalledWith(2, "folder"));
    fireEvent.click(within(header).getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(clientMocks.refresh).toHaveBeenCalledWith(2));
  });
});

// --- authority correction: no GET /api/repositories dependency -------------------
//     + cheap gate completions (picker cancel, per-binding Remove targeting)

describe("Project Detail single binding authority", () => {
  it("renders and drives header primary actions WITHOUT client.repositories() in the page's mock", async () => {
    // `repositories` is absent from the mock module: if the page still tried
    // GET /api/repositories to resolve the display primary, load() would
    // throw and every assertion below would fail.
    const alpha = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    const beta = bindingFixture({ id: 2, localPath: "C:\\work\\beta" });
    projectState = projectFixture({
      localBindings: [alpha, beta],
      snapshot: alpha.snapshot,
      localPath: alpha.localPath,
    });
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    expect(within(bindingsList(container)).getByText("C:\\work\\alpha")).toBeTruthy();

    // The header Open Folder action targets binding A — the server's
    // isPrimary flag is the only authority (no array-order heuristic).
    const header = headerActions(container);
    fireEvent.click(within(header).getByRole("button", { name: "Open Folder" }));
    await waitFor(() => expect(clientMocks.open).toHaveBeenCalledWith(1, "folder"));

    // The header Rescan action targets binding A's repository id too.
    fireEvent.click(within(header).getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(clientMocks.refresh).toHaveBeenCalledWith(1));
    expect(clientMocks.refresh).not.toHaveBeenCalledWith(2);
  });

  it("native picker cancel: no attach call, no error, no fake success", async () => {
    const alpha = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    projectState = projectFixture({
      localBindings: [alpha],
      snapshot: alpha.snapshot,
      localPath: alpha.localPath,
    });
    clientMocks.selectFolder.mockResolvedValue({ selected: false, path: null });
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add local copy" }));

    await waitFor(() => expect(clientMocks.selectFolder).toHaveBeenCalled());
    // Let the picker-cancel continuation settle deterministically.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(clientMocks.addLocalBinding).not.toHaveBeenCalled();
    expect(container.querySelector(".error")).toBeNull();
    expect(within(bindingsList(container)).queryByText("C:\\work\\new-copy")).toBeNull();
  });

  it("per-binding Remove targets the clicked binding's repository id, never the primary's", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const alpha = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    const beta = bindingFixture({ id: 2, localPath: "C:\\work\\beta" });
    projectState = projectFixture({
      localBindings: [alpha, beta],
      snapshot: alpha.snapshot,
      localPath: alpha.localPath,
    });
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    fireEvent.click(within(row(container, 2)).getByRole("button", { name: "Remove" }));

    // The existing M1 removal flow received binding B's id (after the
    // owner accepted the confirmation) — NOT primary A's id.
    await waitFor(() => expect(clientMocks.deleteRepository).toHaveBeenCalledWith(2));
    expect(clientMocks.deleteRepository).not.toHaveBeenCalledWith(1);
  });
});

// --- gate 14: Add Local Copy UI ---------------------------------------------------

describe("Add Local Copy UI", () => {
  it("accepted attach: native folder picker path goes to the project endpoint and the reload shows the new binding", async () => {
    const alpha = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    projectState = projectFixture({
      localBindings: [alpha],
      snapshot: alpha.snapshot,
      localPath: alpha.localPath,
    });
    clientMocks.selectFolder.mockResolvedValue({ selected: true, path: "C:\\work\\new-copy" });
    clientMocks.addLocalBinding.mockImplementation(async () => {
      const added = bindingFixture({ id: 9, localPath: "C:\\work\\new-copy" });
      projectState = projectFixture({
        localBindings: [alpha, added],
        snapshot: alpha.snapshot,
        localPath: alpha.localPath,
      });
      return { binding: added, project: projectState };
    });
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add local copy" }));

    await waitFor(() =>
      expect(clientMocks.addLocalBinding).toHaveBeenCalledWith(42, "C:\\work\\new-copy"),
    );
    await waitFor(() =>
      expect(within(bindingsList(container)).getByText("C:\\work\\new-copy")).toBeTruthy(),
    );
    expect(screen.getAllByText("Primary")).toHaveLength(1);
    expect(container.querySelector("p.lede.mono")?.textContent).toContain("C:\\work\\alpha");
  });

  it("unverified evidence: dialog shows the server summary; declining retries nothing", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const summary =
      "Personal Dev Hub could not verify that this folder belongs to this project: no recognized GitHub remote matches this project and none of its commits overlap this project's history.";
    const alpha = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    projectState = projectFixture({
      localBindings: [alpha],
      snapshot: alpha.snapshot,
      localPath: alpha.localPath,
    });
    clientMocks.selectFolder.mockResolvedValue({ selected: true, path: "C:\\work\\new-copy" });
    clientMocks.addLocalBinding.mockImplementation(async () => {
      throw new MockApiError("LOCAL_BINDING_CONFIRM_REQUIRED", summary, 409);
    });
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add local copy" }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    // The dialog carried the server's evidence summary verbatim.
    expect(confirmSpy.mock.calls[0]?.[0]).toContain(summary);
    // Exactly ONE attach attempt; no confirmed retry happened; nothing changed.
    expect(clientMocks.addLocalBinding).toHaveBeenCalledTimes(1);
    expect(
      clientMocks.addLocalBinding.mock.calls[0]?.[2],
    ).toBeUndefined();
    expect(screen.queryByText("C:\\work\\new-copy")).toBeNull();
  });

  it("unverified evidence: owner approval retries with confirmUnverified=true and attaches", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const summary = "Could not verify this folder belongs to this project.";
    const alpha = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    projectState = projectFixture({
      localBindings: [alpha],
      snapshot: alpha.snapshot,
      localPath: alpha.localPath,
    });
    clientMocks.selectFolder.mockResolvedValue({ selected: true, path: "C:\\work\\new-copy" });
    clientMocks.addLocalBinding.mockImplementation(
      async (_projectId: number, _path: string, confirmUnverified?: boolean) => {
        if (confirmUnverified !== true) {
          throw new MockApiError("LOCAL_BINDING_CONFIRM_REQUIRED", summary, 409);
        }
        const added = bindingFixture({ id: 9, localPath: "C:\\work\\new-copy" });
        projectState = projectFixture({
          localBindings: [alpha, added],
          snapshot: alpha.snapshot,
          localPath: alpha.localPath,
        });
        return { binding: added, project: projectState };
      },
    );
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add local copy" }));

    await waitFor(() =>
      expect(clientMocks.addLocalBinding).toHaveBeenNthCalledWith(
        2,
        42,
        "C:\\work\\new-copy",
        true,
      ),
    );
    await waitFor(() =>
      expect(within(bindingsList(container)).getByText("C:\\work\\new-copy")).toBeTruthy(),
    );
  });

  it("attach errors do not fake success: the error is surfaced and no binding appears", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const alpha = bindingFixture({ id: 1, localPath: "C:\\work\\alpha", isPrimary: true });
    projectState = projectFixture({
      localBindings: [alpha],
      snapshot: alpha.snapshot,
      localPath: alpha.localPath,
    });
    clientMocks.selectFolder.mockResolvedValue({ selected: true, path: "C:\\work\\fake-dir" });
    clientMocks.addLocalBinding.mockImplementation(async () => {
      throw new MockApiError(
        "NOT_GIT_REPOSITORY",
        "The selected folder is not a Git repository.",
        400,
      );
    });
    const { container } = renderPage();

    await waitFor(() => expect(bindingsList(container)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add local copy" }));

    // Non-confirmation errors rethrow straight to the error banner — the
    // owner is never asked to "confirm" a hard validation failure.
    await waitFor(() =>
      expect(screen.getByText("The selected folder is not a Git repository.")).toBeTruthy(),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("C:\\work\\fake-dir")).toBeNull();
  });
});

// --- gate 17: GITHUB ONLY empty bindings panel ------------------------------------

describe("GITHUB ONLY Local Copies panel", () => {
  it("renders the empty state plus the Add local copy affordance", async () => {
    projectState = projectFixture({
      sourceState: "GITHUB ONLY",
      localPath: null,
      snapshot: null,
      githubFullName: "octo/demo",
      githubHtmlUrl: "https://github.com/octo/demo",
      githubMetadata: {
        owner: "octo",
        name: "demo",
        fullName: "octo/demo",
        visibility: "public",
        defaultBranch: "main",
        htmlUrl: "https://github.com/octo/demo",
        lastPushedAt: "2026-08-30T00:00:00.000Z",
      },
      localBindings: [],
    });
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("No local copies attached. This project is tracked from GitHub only."),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Add local copy" })).toBeTruthy();
  });
});
