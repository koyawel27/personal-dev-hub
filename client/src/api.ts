import type {
  ActivityEventDto,
  ApiErrorBody,
  DashboardResponse,
  GitHubStatusDto,
  HealthResponse,
  RepositoryDetail,
  RepositoryListItem,
  ScanSummary,
  SourceDto,
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
  scanSource: (id: number) =>
    api<{ summary: ScanSummary }>(`/api/sources/${id}/scan`, { method: "POST" }),
  scanAll: () => api<{ summary: ScanSummary }>("/api/scans", { method: "POST" }),
  repositories: () =>
    api<{ repositories: RepositoryListItem[] }>("/api/repositories"),
  repository: (id: number) =>
    api<{ repository: RepositoryDetail }>(`/api/repositories/${id}`),
  addManual: (path: string) =>
    api<{ repository: RepositoryDetail }>("/api/repositories/manual", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  refresh: (id: number) =>
    api<{ repository: RepositoryDetail }>(`/api/repositories/${id}/refresh`, {
      method: "POST",
    }),
  deleteRepository: (id: number) =>
    api<{ ok: true }>(`/api/repositories/${id}`, { method: "DELETE" }),
  open: (id: number, action: "folder" | "terminal" | "vscode" | "github") =>
    api<{ ok: true }>(`/api/repositories/${id}/open/${action}`, { method: "POST" }),
  activity: (params?: { repositoryId?: number; from?: string; to?: string }) => {
    const search = new URLSearchParams();
    if (params?.repositoryId) search.set("repositoryId", String(params.repositoryId));
    if (params?.from) search.set("from", params.from);
    if (params?.to) search.set("to", params.to);
    const q = search.toString();
    return api<{ activity: ActivityEventDto[] }>(`/api/activity${q ? `?${q}` : ""}`);
  },
  githubStatus: () => api<{ status: GitHubStatusDto }>("/api/github/status"),
};
