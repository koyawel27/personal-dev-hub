import type {
  ActivityEventDto,
  AddLocalBindingResponse,
  ApiErrorBody,
  ContributionDayDto,
  CreateBackupResponse,
  DailyDetailResponse,
  DashboardResponse,
  DeleteBackupResponse,
  DeleteLocalBindingResponse,
  FolderSelectionResponse,
  GitHubStatusDto,
  HealthResponse,
  ListBackupsResponse,
  PortfolioItemDto,
  ProjectDetailDto,
  ProjectListItemDto,
  RelinkLocalBindingResponse,
  RepositoryDetail,
  RepositoryListItem,
  RestoreStateResponse,
  ScheduleRestoreResponse,
  SetPrimaryLocalBindingResponse,
  SourceHealthResponse,
  ScanSummary,
  SourceDto,
  PickerEntryDto,
  UpdateMetadataRequest,
} from "@shared/api-types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const body = data as ApiErrorBody | null;
    throw new ApiError(
      body?.error?.code || "INTERNAL_ERROR",
      body?.error?.message || "Request failed.",
      res.status,
    );
  }
  return data as T;
}

export const client = {
  health: () => api<HealthResponse>("/api/health"),
  dashboard: () => api<DashboardResponse>("/api/dashboard"),
  sources: () => api<{ sources: SourceDto[] }>("/api/sources"),
  addSource: (path: string, scanDepth: number) =>
    api<{ source: SourceDto }>("/api/sources", {
      method: "POST",
      body: JSON.stringify({ path, scanDepth }),
    }),
  deleteSource: (id: number) =>
    api<{ ok: true }>(`/api/sources/${id}`, { method: "DELETE" }),
  selectFolder: () =>
    api<FolderSelectionResponse>("/api/system/select-folder", { method: "POST" }),
  scanSource: (id: number) =>
    api<{ summary: ScanSummary }>(`/api/sources/${id}/scan`, { method: "POST" }),
  scanAll: () => api<{ summary: ScanSummary }>("/api/scans", { method: "POST" }),
  repositories: () =>
    api<{ repositories: RepositoryListItem[] }>("/api/repositories"),
  addManual: (path: string) =>
    api<{ repository: RepositoryDetail }>("/api/repositories/manual", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  // Local-binding operations (rescan / remove-from-dashboard): the id is a
  // LOCAL REPOSITORY id, never a Project id. Project state lives under
  // client.project / client.updateProjectMetadata.
  refresh: (localRepositoryId: number) =>
    api<{ repository: RepositoryDetail }>(
      `/api/repositories/${localRepositoryId}/refresh`,
      { method: "POST" },
    ),
  deleteRepository: (localRepositoryId: number, confirmDeleteProject?: boolean) =>
    api<DeleteLocalBindingResponse>(
      `/api/repositories/${localRepositoryId}${confirmDeleteProject ? "?confirmDeleteProject=true" : ""}`,
      { method: "DELETE" },
    ),
  // V1.2 M1: display-primary switch (pure preference flip; no activity event).
  setLocalPrimary: (localRepositoryId: number) =>
    api<SetPrimaryLocalBindingResponse>(
      `/api/repositories/${localRepositoryId}/primary`,
      { method: "POST" },
    ),
  // V1.2 M4: Safe Relink — point the SAME existing binding at a moved/renamed
  // folder. The id is the EXISTING LOCAL REPOSITORY binding id; binding
  // identity and history are preserved. confirmUnverified=true is the owner's
  // explicit answer to LOCAL_BINDING_RELINK_CONFIRM_REQUIRED.
  relinkLocalBinding: (localRepositoryId: number, path: string, confirmUnverified?: boolean) =>
    api<RelinkLocalBindingResponse>(
      `/api/repositories/${localRepositoryId}/relink`,
      {
        method: "POST",
        body: JSON.stringify(
          confirmUnverified ? { path, confirmUnverified: true } : { path },
        ),
      },
    ),
  // V1.2 M3: Add Local Copy — attach an existing local Git folder to an
  // EXISTING project. The id is a PROJECT id; confirmUnverified=true is the
  // owner's explicit answer to LOCAL_BINDING_CONFIRM_REQUIRED.
  addLocalBinding: (projectId: number, path: string, confirmUnverified?: boolean) =>
    api<AddLocalBindingResponse>(`/api/projects/${projectId}/local-bindings`, {
      method: "POST",
      body: JSON.stringify(
        confirmUnverified ? { path, confirmUnverified: true } : { path },
      ),
    }),
  open: (
    localRepositoryId: number,
    action: "folder" | "terminal" | "vscode" | "github",
  ) =>
    api<{ ok: true }>(
      `/api/repositories/${localRepositoryId}/open/${action}`,
      { method: "POST" },
    ),
  activity: (params?: { repositoryId?: number; projectId?: number; from?: string; to?: string }) => {
    const search = new URLSearchParams();
    if (params?.repositoryId) search.set("repositoryId", String(params.repositoryId));
    if (params?.projectId) search.set("projectId", String(params.projectId));
    if (params?.from) search.set("from", params.from);
    if (params?.to) search.set("to", params.to);
    const q = search.toString();
    return api<{ activity: ActivityEventDto[] }>(`/api/activity${q ? `?${q}` : ""}`);
  },
  activityPage: (params: {
    projectId?: number;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const search = new URLSearchParams();
    if (params.projectId) search.set("projectId", String(params.projectId));
    if (params.from) search.set("from", params.from);
    if (params.to) search.set("to", params.to);
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit) search.set("limit", String(params.limit));
    const q = search.toString();
    return api<{ rows: ActivityEventDto[]; nextCursor: string | null }>(
      `/api/activity/page${q ? `?${q}` : ""}`,
    );
  },
  githubStatus: () => api<{ status: GitHubStatusDto }>("/api/github/status"),
  settings: () =>
    api<{
      settings: { defaultScanDepth: number; gitExecutable: string; dataPath: string };
    }>("/api/settings"),
  updateSettings: (body: { defaultScanDepth?: number }) =>
    api<{
      settings: { defaultScanDepth: number; gitExecutable: string; dataPath: string };
    }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  contributions: (view?: "local" | "github" | "combined") =>
    api<{ days: ContributionDayDto[]; source: string }>(
      `/api/contributions${view && view !== "combined" ? `?view=${view}` : ""}`,
    ),
  contributionYears: () =>
    api<{ years: number[] }>("/api/contributions/years"),
  contributionYear: (year: number, view: "local" | "github" | "combined") =>
    api<{
      year: number;
      source: string;
      days: ContributionDayDto[];
      totals: { commits: number; activeDays: number; projects: number };
      dedup?: {
        localObserved: number;
        githubObserved: number;
        overlap: number;
        combinedUnique: number;
      };
    }>(`/api/contributions/year?y=${year}&view=${view}`),
  contributionDay: (day: string, view?: "local" | "github" | "combined") =>
    api<DailyDetailResponse>(
      `/api/contributions/${day}${view && view !== "combined" ? `?view=${view}` : ""}`,
    ),
  portfolio: () =>
    api<{ projects: PortfolioItemDto[] }>("/api/portfolio"),
  // --- V1.1 project + GitHub tracking ---
  projects: (params?: { state?: string; query?: string }) => {
    const search = new URLSearchParams();
    if (params?.state) search.set("state", params.state);
    if (params?.query) search.set("query", params.query);
    const q = search.toString();
    return api<{ projects: ProjectListItemDto[] }>(`/api/projects${q ? `?${q}` : ""}`);
  },
  project: (projectId: number) =>
    api<{ project: ProjectDetailDto }>(`/api/projects/${projectId}`),
  updateProjectMetadata: (projectId: number, body: UpdateMetadataRequest) =>
    api<{ project: ProjectDetailDto }>(`/api/projects/${projectId}/metadata`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  githubPicker: () =>
    api<{
      entries: PickerEntryDto[];
      available: boolean;
    }>("/api/github/repositories"),

  trackGithub: (fullName: string) =>
    api<{ githubRepositoryId: number; projectId: number; state: string }>(
      "/api/github/tracked",
      { method: "POST", body: JSON.stringify({ fullName }) },
    ),
  untrackGithub: (githubBindingId: number, confirmDeleteProject?: boolean) =>
    api<{ ok: true; projectDeleted: boolean }>(
      `/api/github/tracked/${githubBindingId}${confirmDeleteProject ? "?confirmDeleteProject=true" : ""}`,
      { method: "DELETE" },
    ),
  refreshTrackedGithub: (githubBindingId: number) =>
    api<{ ok: boolean; reason?: string; newCommits?: number }>(
      `/api/github/tracked/${githubBindingId}/refresh`,
      { method: "POST" },
    ),
  // --- V1.3 M2 application backups (Maintenance) ---
  listBackups: () => api<ListBackupsResponse>("/api/backups"),
  createBackup: () =>
    api<CreateBackupResponse>("/api/backups", { method: "POST" }),
  deleteBackup: (id: string) =>
    api<DeleteBackupResponse>(`/api/backups/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  // --- V1.3 M3 restart-mediated restore ---
  restoreState: () => api<RestoreStateResponse>("/api/restore"),
  scheduleRestore: (id: string) =>
    api<ScheduleRestoreResponse>(
      `/api/backups/${encodeURIComponent(id)}/restore`,
      {
        method: "POST",
        body: JSON.stringify({ confirmRestore: true }),
      },
    ),
  clearRestoreState: () =>
    api<{ ok: true; restore: null }>("/api/restore", { method: "DELETE" }),
  // --- V1.3 M4 Maintenance source health (read-only attention list) ---
  sourceHealth: () =>
    api<SourceHealthResponse>("/api/maintenance/source-health"),
  // --- Cooperative local restart (Windows launcher handoff) ---
  restartApp: () =>
    api<{ ok: true; restarting: true }>("/api/system/restart", {
      method: "POST",
    }),
};
