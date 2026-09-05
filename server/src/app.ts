import fs from "node:fs";
import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { AppError, ErrorCodes, toErrorBody } from "./lib/errors.js";
import { parseNumericId } from "./lib/fsPaths.js";
import { gitIsAvailable, resolveGitPath } from "./lib/gitRunner.js";
import { getDb } from "./db/client.js";
import { getGitHubStatus } from "./services/GitHubService.js";
import {
  addSource,
  deleteSource,
  listSources,
} from "./services/ProjectDiscoveryService.js";
import {
  addManualRepository,
  attachLocalBinding,
  deleteRepository,
  getRepositoryDetail,
  listActivity,
  listRepositories,
  refreshRepository,
  scanAllSources,
  scanSource,
} from "./services/RepositoryService.js";
import { getDashboard } from "./services/DashboardService.js";
import { launchRepositoryAction } from "./services/SystemLauncher.js";
import { selectFolder } from "./services/FolderPickerService.js";
import {
  deriveSourceState,
  getProjectDetail,
  listProjects,
  setPrimaryLocalBinding,
  trackGitHubRepository,
  untrackGitHubRepository,
  updateProjectMetadata,
} from "./services/ProjectService.js";
import {
  contributionDays,
  contributionYear,
  contributionYears,
  dailyDetail,
} from "./services/ContributionService.js";
import { listActivityPaged } from "./services/ActivityService.js";
import { buildPicker, refreshTrackedBinding } from "./services/GitHubPickerService.js";
import { listPortfolio } from "./services/PortfolioService.js";
import {
  getDefaultScanDepth,
  setDefaultScanDepth,
} from "./services/SettingsService.js";

function requireId(value: string | undefined, kind: "repository" | "source"): number {
  const id = parseNumericId(value);
  if (id == null) {
    throw new AppError(
      kind === "repository"
        ? ErrorCodes.REPOSITORY_NOT_FOUND
        : ErrorCodes.SOURCE_NOT_FOUND,
      kind === "repository"
        ? "Repository was not found."
        : "Scan location was not found.",
      404,
    );
  }
  return id;
}

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", async (_req, res, next) => {
    try {
      const git = (await gitIsAvailable()) ? "available" : "unavailable";
      res.json({ ok: true, git });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/sources", (_req, res, next) => {
    try {
      res.json({ sources: listSources() });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/sources", (req, res, next) => {
    try {
      const source = addSource({
        path: req.body?.path,
        scanDepth: req.body?.scanDepth,
      });
      res.status(201).json({ source });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/sources/:id", (req, res, next) => {
    try {
      deleteSource(requireId(req.params.id, "source"));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/sources/:id/scan", async (req, res, next) => {
    try {
      const summary = await scanSource(requireId(req.params.id, "source"));
      res.json({ summary });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/scans", async (_req, res, next) => {
    try {
      const summary = await scanAllSources();
      res.json({ summary });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/repositories", (_req, res, next) => {
    try {
      res.json({ repositories: listRepositories() });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/repositories/manual", async (req, res, next) => {
    try {
      const repository = await addManualRepository({ path: req.body?.path });
      res.status(201).json({ repository });
    } catch (err) {
      next(err);
    }
  });

  // NOTE: no GET /api/repositories/:id detail route — the Project is the
  // domain entity and lives at GET /api/projects/:projectId. (The legacy
  // repository-as-project shim was retired in V1.1 cleanup.)

  app.post("/api/repositories/:id/refresh", async (req, res, next) => {
    try {
      const repository = await refreshRepository(
        requireId(req.params.id, "repository"),
      );
      res.json({ repository });
    } catch (err) {
      next(err);
    }
  });

  // NOTE: no PATCH /api/repositories/:id/metadata — manual metadata is
  // PROJECT state and belongs to PATCH /api/projects/:projectId/metadata.
  // (The legacy repository-as-project shim was retired in V1.1 cleanup;
  // see server/tests/api-identity-guard.test.ts.)

  app.delete("/api/repositories/:id", (req, res, next) => {
    try {
      // Q1 lifecycle for the local binding's owning Project: empty projects
      // auto-delete, meaningful ones refuse pending explicit confirmation.
      const confirmDeleteProject = req.query.confirmDeleteProject === "true";
      res.json(
        deleteRepository(requireId(req.params.id, "repository"), { confirmDeleteProject }),
      );
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/repositories/:id/primary", (req, res, next) => {
    try {
      // V1.2 M1: display-primary switch — a pure UI/source preference flip.
      // No Git operation, no filesystem access, no development Activity event.
      res.json(setPrimaryLocalBinding(requireId(req.params.id, "repository")));
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/projects", (req, res, next) => {
    try {
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      const query = typeof req.query.query === "string" ? req.query.query : undefined;
      res.json({ projects: listProjects({ state, query }) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/projects/:id", async (req, res, next) => {
    try {
      const project = await getProjectDetail(requireId(req.params.id, "repository"));
      res.json(project);
    } catch (err) {
      next(err);
    }
  });

  app.patch("/api/projects/:id/metadata", async (req, res, next) => {
    try {
      await updateProjectMetadata(requireId(req.params.id, "repository"), req.body);
      const project = await getProjectDetail(requireId(req.params.id, "repository"));
      res.json(project);
    } catch (err) {
      next(err);
    }
  });

  // V1.2 M3: owner-directed Add Local Copy — attach an existing local Git
  // folder to THIS project as another local binding. The Project already
  // exists and is never duplicated; Git is read-only; evidence rules may
  // demand explicit owner confirmation (LOCAL_BINDING_CONFIRM_REQUIRED) or
  // reject a strong identity conflict outright.
  app.post("/api/projects/:id/local-bindings", async (req, res, next) => {
    try {
      const result = await attachLocalBinding(requireId(req.params.id, "repository"), {
        path: req.body?.path,
        confirmUnverified: req.body?.confirmUnverified,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/github/tracked", async (req, res, next) => {
    try {
      const result = await trackGitHubRepository({ fullName: req.body?.fullName });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/github/tracked/:id", (req, res, next) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id == null) {
        throw new AppError(ErrorCodes.GITHUB_REPO_NOT_FOUND, "Not found.", 404);
      }
      const confirmDeleteProject = req.query.confirmDeleteProject === "true";
      untrackGitHubRepository({ githubRepositoryId: id, confirmDeleteProject })
        .then((result) => res.json(result))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/github/repositories", async (_req, res, next) => {
    try {
      const picker = await buildPicker();
      res.json(picker);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/github/tracked/:id/refresh", (req, res, next) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id == null) {
        throw new AppError(ErrorCodes.GITHUB_REPO_NOT_FOUND, "Not found.", 404);
      }
      refreshTrackedBinding(id)
        .then((result) => res.json(result))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/repositories/:id/open/:action", (req, res, next) => {
    try {
      const action = req.params.action;
      if (
        action !== "folder" &&
        action !== "terminal" &&
        action !== "vscode" &&
        action !== "github"
      ) {
        throw new AppError(ErrorCodes.REPOSITORY_NOT_FOUND, "Unknown action.", 404);
      }
      const result = launchRepositoryAction(
        requireId(req.params.id, "repository"),
        action,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Native folder selection for the Sources path inputs. Parameterless by
  // design: nothing from the request can shape the executed command, and
  // the dialog is pure UI — no source configuration is touched. The server
  // binds to 127.0.0.1 (local-first app), so this surface is only reachable
  // from the owner's machine; it never deletes/moves/creates anything.
  //
  // Client disconnect (browser refresh/close) aborts the picker: the dialog
  // child is terminated and the single-flight guard clears, so a refresh
  // can never leave a permanent BUSY state or a zombie dialog behind.
  // Expressed over the raw response 'close' event so it does not depend on
  // Express-version-specific request abortSignal typings.
  app.post("/api/system/select-folder", (req, res, next) => {
    const disconnect = new AbortController();
    const onClose = (): void => disconnect.abort();
    res.on("close", onClose);
    selectFolder(disconnect.signal)
      .then((outcome) => {
        res.off("close", onClose);
        res.json(outcome);
      })
      .catch((err: unknown) => {
        res.off("close", onClose);
        if (!res.headersSent) {
          next(err);
        }
      });
  });

  app.get("/api/activity", (req, res, next) => {
    try {
      const repositoryIdRaw = req.query.repositoryId;
      const projectIdRaw = req.query.projectId;
      const repositoryId =
        typeof repositoryIdRaw === "string" && repositoryIdRaw
          ? requireId(repositoryIdRaw, "repository")
          : undefined;
      const projectId =
        typeof projectIdRaw === "string" && projectIdRaw
          ? requireId(projectIdRaw, "repository")
          : undefined;
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      // V1.1: a binding filter maps to its project's event stream so legacy
      // clients keep seeing the full per-project journal.
      let effectiveProjectId = projectId;
      if (effectiveProjectId == null && repositoryId != null) {
        const row = getDb()
          .prepare("SELECT project_id FROM local_repositories WHERE id = ?")
          .get(repositoryId) as { project_id: number | null } | undefined;
        effectiveProjectId = row?.project_id ?? undefined;
      }
      res.json({
        // When filtering through a binding's project, drop the binding
        // filter: the journal is project-level (metadata events have no
        // local binding attached).
        activity: listActivity({ projectId: effectiveProjectId, from, to }),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/activity/page", (req, res, next) => {
    try {
      const repositoryIdRaw = req.query.repositoryId;
      const projectIdRaw = req.query.projectId;
      const repositoryId =
        typeof repositoryIdRaw === "string" && repositoryIdRaw
          ? requireId(repositoryIdRaw, "repository")
          : undefined;
      const projectId =
        typeof projectIdRaw === "string" && projectIdRaw
          ? requireId(projectIdRaw, "repository")
          : undefined;
      let effectiveProjectId = projectId;
      if (effectiveProjectId == null && repositoryId != null) {
        const row = getDb()
          .prepare("SELECT project_id FROM local_repositories WHERE id = ?")
          .get(repositoryId) as { project_id: number | null } | undefined;
        effectiveProjectId = row?.project_id ?? undefined;
      }
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
      res.json(
        listActivityPaged({
          projectId: effectiveProjectId,
          from,
          to,
          cursor,
          limit,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/contributions", (req, res, next) => {
    try {
      const from = typeof req.query.from === "string" ? req.query.from : null;
      const to = typeof req.query.to === "string" ? req.query.to : null;
      const rawView = typeof req.query.view === "string" ? req.query.view : "combined";
      const view =
        rawView === "local" || rawView === "github" || rawView === "combined"
          ? rawView
          : "combined";
      res.json({ days: contributionDays(from, to, view), source: view });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/contributions/years", (req, res, next) => {
    try {
      void req;
      res.json({ years: contributionYears() });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/contributions/year", (req, res, next) => {
    try {
      const rawYear = typeof req.query.y === "string" ? Number(req.query.y) : new Date().getUTCFullYear();
      const rawView = typeof req.query.view === "string" ? req.query.view : "combined";
      const view =
        rawView === "local" || rawView === "github" || rawView === "combined"
          ? rawView
          : "combined";
      res.json(contributionYear(Number(rawYear), view));
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/contributions/:day", (req, res, next) => {
    try {
      const rawView = typeof req.query.view === "string" ? req.query.view : "combined";
      const view =
        rawView === "local" || rawView === "github" || rawView === "combined"
          ? rawView
          : "combined";
      res.json(dailyDetail(req.params.day, view));
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/portfolio", (_req, res, next) => {
    try {
      res.json({ projects: listPortfolio() });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/dashboard", (_req, res, next) => {
    try {
      res.json(getDashboard());
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/github/status", async (_req, res, next) => {
    try {
      res.json({ status: await getGitHubStatus() });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/settings", (_req, res, next) => {
    try {
      res.json({
        settings: {
          defaultScanDepth: getDefaultScanDepth(),
          gitExecutable: resolveGitPath(),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.patch("/api/settings", (req, res, next) => {
    try {
      if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
        throw new AppError(
          ErrorCodes.INVALID_REQUEST,
          "Settings payload must be an object.",
        );
      }
      const body = req.body as Record<string, unknown>;
      if (Object.keys(body).some((key) => key !== "defaultScanDepth")) {
        throw new AppError(
          ErrorCodes.INVALID_REQUEST,
          "Only defaultScanDepth can be changed.",
        );
      }
      const defaultScanDepth = setDefaultScanDepth(body.defaultScanDepth);
      res.json({
        settings: {
          defaultScanDepth,
          gitExecutable: resolveGitPath(),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({
      error: { code: ErrorCodes.INTERNAL_ERROR, message: "Not found." },
    });
  });

  if (fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) {
        next();
        return;
      }
      res.sendFile(path.join(config.clientDist, "index.html"));
    });
  }

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const { status, body } = toErrorBody(err);
      res.status(status).json(body);
    },
  );

  return app;
}
