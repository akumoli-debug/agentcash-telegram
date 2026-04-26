import http, { type Server } from "node:http";
import type { AppConfig } from "./config.js";
import type { AppLogger } from "./lib/logger.js";

export interface ReadinessProbe {
  name: string;
  check: () => Promise<void> | void;
}

export function startHealthServer(
  config: AppConfig,
  logger: AppLogger,
  probes: ReadinessProbe[] = []
): Server {
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));
      return;
    }

    if (req.url === "/readyz") {
      const checks = await runReadinessChecks(probes);
      const ok = checks.every(check => check.ok);
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, checks }));
      return;
    }

    if (req.url === "/metrics") {
      const uptimeSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end([
        "# HELP agentcash_process_alive Process alive indicator",
        "# TYPE agentcash_process_alive gauge",
        "agentcash_process_alive 1",
        "# HELP agentcash_process_uptime_seconds Process uptime in seconds",
        "# TYPE agentcash_process_uptime_seconds counter",
        `agentcash_process_uptime_seconds ${uptimeSeconds}`,
        ""
      ].join("\n"));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });

  server.listen(config.HEALTH_PORT, config.HEALTH_HOST, () => {
    logger.info(
      { healthHost: config.HEALTH_HOST, healthPort: config.HEALTH_PORT },
      "health server started"
    );
  });

  return server;
}

async function runReadinessChecks(probes: ReadinessProbe[]) {
  const checks = [];

  for (const probe of probes) {
    try {
      await probe.check();
      checks.push({ name: probe.name, ok: true });
    } catch (error) {
      checks.push({
        name: probe.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return checks;
}
