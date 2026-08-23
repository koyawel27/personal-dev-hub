import fs from "node:fs";
import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { AppError, ErrorCodes, toErrorBody } from "./lib/errors.js";
import { parseNumericId } from "./lib/fsPaths.js";
import { gitIsAvailable } from "./lib/gitRunner.js";
import { getGitHubStatus } from "./services/GitHubService.js";
import {
  addSource,
  deleteSource,
  listSources,
} from "./services/ProjectDiscoveryService.js";
import {
  addManualRepository,
  deleteRepository,
  getDashboard,
  getRepositoryDetail,
  listActivity,
  listRepositories,
  refreshRepository,
  scanAllSources,
  scanSource,
  updateMetadata,
} from "./services/RepositoryService.js";
import { launchRepositoryAction } from "./services/SystemLauncher.js";
import {
  contributionDays,
  dailyDetail,
} from "./services/ContributionService.js";
import { listPortfolio } from "./services/PortfolioService.js";

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

  app.get("/api/repositories/:id", async (req, res, next) => {
    try {
      const repository = await getRepositoryDetail(
        requireId(req.params.id, "repository"),
      );
      res.json({ repository });
    } catch (err) {
      next(err);
    }
  });

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

  app.patch("/api/repositories/:id/metadata", async (req, res, next) => {
    try {
      const repository = await updateMetadata(
        requireId(req.params.id, "repository"),
        req.body,
      );
      res.json({ repository });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/repositories/:id", (req, res, next) => {
    try {
      deleteRepository(requireId(req.params.id, "repository"));
      res.json({ ok: true });
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

  app.get("/api/activity", (req, res, next) => {
    try {
      const repositoryIdRaw = req.query.repositoryId;
      const repositoryId =
        typeof repositoryIdRaw === "string" && repositoryIdRaw
          ? requireId(repositoryIdRaw, "repository")
          : undefined;
      const from = typeof req.query.from === "string" ? req.query.from : undefined;
      const to = typeof req.query.to === "string" ? req.query.to : undefined;
      res.json({ activity: listActivity({ repositoryId, from, to }) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/contributions", (req, res, next) => {
    try {
      const from = typeof req.query.from === "string" ? req.query.from : null;
      const to = typeof req.query.to === "string" ? req.query.to : null;
      res.json({ days: contributionDays(from, to) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/contributions/:day", (req, res, next) => {
    try {
      res.json(dailyDetail(req.params.day));
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
