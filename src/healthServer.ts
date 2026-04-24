import http, { type Server } from "node:http";
import type { AppConfig } from "./config.js";
import type { AppLogger } from "./lib/logger.js";

export function startHealthServer(config: AppConfig, logger: AppLogger): Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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
