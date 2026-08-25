// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sources Browse… click path (jsdom): the native picker is a backend seam,
 * so these tests pin the CLIENT contract around it — field population for
 * both forms, silent cancellation, failure UX that preserves manual entry,
 * no auto-submit, and single-flight protection against stacked dialogs.
 */

const selectFolder = vi.fn();
const addSource = vi.fn();
const addManual = vi.fn();

vi.mock("../../client/src/api.js", () => ({
  ApiError: class MockApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  client: {
    sources: () => Promise.resolve({ sources: [] }),
    repositories: () => Promise.resolve({ repositories: [] }),
    selectFolder: (...args: unknown[]) => selectFolder(...args),
    addSource: (...args: unknown[]) => addSource(...args),
    addManual: (...args: unknown[]) => addManual(...args),
    scanSource: () => Promise.resolve({ summary: {} }),
    deleteSource: () => Promise.resolve({ ok: true }),
    scanAll: () => Promise.resolve({ summary: {} }),
    refresh: () => Promise.resolve({}),
    deleteRepository: () => Promise.resolve({ ok: true, projectDeleted: false }),
    githubPicker: () =>
      Promise.reject(new Error("picker not exercised in this suite")),
  },
}));

async function renderSources() {
  const { SourcesPage } = await import("../../client/src/pages/SourcesPage.js");
  return render(<SourcesPage />);
}

function scanLocationInput(): HTMLInputElement {
  return screen.getByPlaceholderText("C:\\xampp-projects") as HTMLInputElement;
}

function manualRepoInput(): HTMLInputElement {
  return screen.getByPlaceholderText("C:\\path\\to\\git-repo") as HTMLInputElement;
}

/** The Scan Locations panel section, so queries never cross forms. */
function scanLocationsPanel(): HTMLElement {
  return screen
    .getByRole("heading", { name: "Scan Locations" })
    .closest("section") as HTMLElement;
}

/** Browse button of the Scan Locations form (matches Browse… and Browsing…). */
function scanBrowseButton(): HTMLButtonElement {
  return within(scanLocationsPanel()).getByRole("button", {
    name: /Brows/,
  }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.resetModules();
  selectFolder.mockReset();
  addSource.mockReset().mockResolvedValue({});
  addManual.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.textContent = "";
});

describe("Sources Browse… click path", () => {
  it("populates the Scan Location field with the chosen folder; no auto-submit", async () => {
    selectFolder.mockResolvedValue({ selected: true, path: "C:\\temp\\chosen-one" });
    await renderSources();

    fireEvent.click(scanBrowseButton());

    await waitFor(() => expect(scanLocationInput().value).toBe("C:\\temp\\chosen-one"));
    expect(addSource).not.toHaveBeenCalled(); // owner must click Add explicitly
  });

  it("populates the Individual Repository field", async () => {
    selectFolder.mockResolvedValue({
      selected: true,
      path: "C:\\repos\\some-repo",
    });
    await renderSources();

    const browseButtons = screen.getAllByRole("button", { name: /Brows/ });
    fireEvent.click(browseButtons[1]);

    await waitFor(() => expect(manualRepoInput().value).toBe("C:\\repos\\some-repo"));
    expect(addManual).not.toHaveBeenCalled();
  });

  it("cancel keeps the existing value and shows no warning", async () => {
    selectFolder.mockResolvedValue({ selected: false, path: null });
    await renderSources();

    const input = scanLocationInput();
    fireEvent.change(input, { target: { value: "C:\\my\\typed\\path" } });
    fireEvent.click(scanBrowseButton());

    await waitFor(() => expect(selectFolder).toHaveBeenCalled());
    await waitFor(() => expect(scanBrowseButton().disabled).toBe(false));
    expect(input.value).toBe("C:\\my\\typed\\path");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("failure preserves the field value, keeps manual entry usable, stays restrained", async () => {
    const { ApiError } = await import("../../client/src/api.js");
    const apiError = new (ApiError as new (
      code: string,
      message: string,
      status: number,
    ) => Error)("FOLDER_PICKER_FAILED", "PowerShell went missing", 500) as Error & {
      code: string;
    };
    selectFolder.mockRejectedValue(apiError);
    await renderSources();

    const input = scanLocationInput();
    fireEvent.change(input, { target: { value: "C:\\keep\\me" } });
    fireEvent.click(scanBrowseButton());

    const hint = await screen.findByRole("status");
    expect(hint.textContent).toContain("Folder browser unavailable");
    expect(hint.textContent).toContain("manually");
    expect(input.value).toBe("C:\\keep\\me");

    // Manual flow still fully works after a picker failure.
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(addSource).toHaveBeenCalledWith("C:\\keep\\me", 3));
  });

  it("manual editing still works after a successful Browse", async () => {
    selectFolder.mockResolvedValue({ selected: true, path: "C:\\browsed" });
    await renderSources();

    fireEvent.click(scanBrowseButton());
    await waitFor(() => expect(scanLocationInput().value).toBe("C:\\browsed"));

    const input = scanLocationInput();
    fireEvent.change(input, { target: { value: "C:\\browsed\\edited" } });
    expect(input.value).toBe("C:\\browsed\\edited");

    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(addSource).toHaveBeenCalledWith("C:\\browsed\\edited", 3));
  });

  it("rapid repeat clicks while pending launch exactly one request", async () => {
    let release!: (value: { selected: boolean; path: string | null }) => void;
    selectFolder.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await renderSources();

    const browse = scanBrowseButton();
    fireEvent.click(browse);
    fireEvent.click(browse);
    fireEvent.click(browse);

    // Disabled while pending; the handler also guards re-entrancy.
    expect(browse.disabled).toBe(true);
    expect(browse.textContent).toContain("Browsing");
    release({ selected: false, path: null });

    await waitFor(() => expect(browse.disabled).toBe(false));
    expect(selectFolder).toHaveBeenCalledTimes(1);
  });
});
