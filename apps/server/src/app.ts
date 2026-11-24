import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AppDeps } from './deps.ts';
import { ok, fail, registerErrorHandler } from './http/errors.ts';
import { registerAccountRoutes } from './modules/account/routes.ts';
import { registerAiRoutes } from './modules/ai/routes.ts';
import { registerAuthRoutes } from './modules/auth/routes.ts';
import { registerLibraryRoutes } from './modules/library/routes.ts';
import { registerLookupRoutes } from './modules/lookup/routes.ts';
import { registerReviewRoutes } from './modules/review/routes.ts';
import { registerSyncRoutes } from './modules/sync/routes.ts';
import { registerTtsRoutes } from './modules/tts/routes.ts';

/**
 * Build the HTTP app. All I/O dependencies come in through `deps`, so tests
 * run the real routes against a real database with fake WeChat / LLM / clock.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      // Never log credentials. Request bodies are not logged at all: they
      // carry the user's private text.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Exactly one proxy (heji's nginx) sits in front. Trusting more hops would
    // let a client spoof X-Forwarded-For and dodge the per-IP rate limits.
    trustProxy: (_address: string, hop: number) => hop < 1,
    bodyLimit: 1024 * 1024,
  });

  registerErrorHandler(app);

  app.get('/healthz', async () => ok({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await deps.db.execute(sql`select 1`);
      return ok({ status: 'ready' });
    } catch {
      return reply.status(503).send(fail('NOT_READY', 'database unavailable'));
    }
  });

  await registerAuthRoutes(app, deps);
  await registerSyncRoutes(app, deps);
  await registerAiRoutes(app, deps);
  await registerTtsRoutes(app, deps);
  await registerReviewRoutes(app, deps);
  await registerLibraryRoutes(app, deps);
  await registerAccountRoutes(app, deps);
  await registerLookupRoutes(app, deps);

  return app;
}
