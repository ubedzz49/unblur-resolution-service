import { buildApp } from "./app.js";
import { buildDbPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { PostgresResolutionRepository } from "./resolution/postgres-repository.js";
import { HttpDoubtClient } from "./doubts/client.js";
import { HttpPaymentClient } from "./payments/client.js";
import { HttpStatsClient } from "./stats/client.js";
import { HttpMeetingClient } from "./meetings/client.js";
import { HttpNotificationClient } from "./notifications/client.js";
import { HttpAiNotesClient } from "./ai-notes/client.js";
import { logger } from "./logger.js";

const port = Number(process.env.PORT ?? 3005);

// fail closed, same philosophy as every other service's INTERNAL_SERVICE_TOKEN check -- an
// unset token would otherwise mean the new /internal/log-level route silently accepts anything
if (!process.env.INTERNAL_SERVICE_TOKEN) {
  logger.fatal("INTERNAL_SERVICE_TOKEN is not set, refusing to start");
  process.exit(1);
}

const dbPool = buildDbPool();

runMigrations(dbPool)
  .then(() => {
    const app = buildApp(
      new PostgresResolutionRepository(dbPool),
      new HttpDoubtClient(),
      new HttpPaymentClient(),
      new HttpStatsClient(),
      new HttpMeetingClient(),
      new HttpNotificationClient(),
      new HttpAiNotesClient(),
      process.env.INTERNAL_SERVICE_TOKEN,
    );
    return app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info({ port }, "resolution-service listening"));
  })
  .catch((err) => {
    logger.error({ err }, "resolution-service failed to start");
    process.exit(1);
  });
