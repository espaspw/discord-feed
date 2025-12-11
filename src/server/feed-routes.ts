import { FastifyPluginAsync } from 'fastify';

import { resourceParamsSchema, feedUpdateBodySchema, feedBodySchema, feedLastIdUpdateBodySchema } from './schemas';
import { FeedManager } from '../FeedManager';
import { FeedConfig, WebhookDestination, ResolvedFeedConfig } from '../types';

type FeedResponse = ResolvedFeedConfig & { id: number, isRunning: boolean };

export const feedRoutes: FastifyPluginAsync = async (fastify, opts) => {
  const { feedManager } = fastify as { feedManager: FeedManager };

  // GET /api/feeds
  fastify.get<{ Reply: FeedResponse[] }>('/', async (request, reply) => {
    return feedManager.getAllFeedsFromDb();
  });

  // GET /api/feeds/:name
  fastify.get<{ Params: { name: string }, Reply: FeedResponse }>('/:name', {
    schema: {
      params: resourceParamsSchema,
    }
  }, async (request, reply) => {
    const config = feedManager.getFeedConfigByName(request.params.name);
    if (config) {
      // Re-resolve to get webhookDestinations for the response
      const resolvedConfig = feedManager.getResolvedFeedConfigByName(request.params.name);
      return {
        ...resolvedConfig,
        isRunning: feedManager.activeFeeds.has(config.name),
      };
    }
    reply.status(404).send({ message: `Feed with name '${request.params.name}' not found.` });
  });

  // POST /api/feeds
  fastify.post<{ Body: FeedConfig, Reply: FeedConfig }>('/', {
    schema: {
      body: feedBodySchema,
    }
  }, async (request, reply) => {
    try {
      const body = request.body;
      body.pollingIntervalMs = body.pollingIntervalMs ?? 60000;
      body.batchSize = body.batchSize ?? 3;
      const newFeed = feedManager.createFeed(body);
      reply.status(201); // 201 Created
      return newFeed;
    } catch (error: any) {
      reply.status(400).send({ message: error.message });
    }
  });

  // PUT /api/feeds/:name
  fastify.put<{ Params: { name: string }, Body: Partial<FeedConfig>, Reply: ResolvedFeedConfig }>('/:name', {
    schema: {
      params: resourceParamsSchema,
      body: feedUpdateBodySchema,
    }
  }, async (request, reply) => {
    try {
      const updatedFeed = feedManager.updateFeed(request.params.name, request.body);
      return updatedFeed;
    } catch (error: any) {
      // Handles 404 (feed not found) and 400 (webhook not found/name conflict)
      const statusCode = error.message.includes('not found') ? 404 : 400;
      reply.status(statusCode).send({ message: error.message });
    }
  });

  // DELETE /api/feeds/:name
  fastify.delete<{ Params: { name: string }, Reply: { message: string } | void }>('/:name', {
    schema: {
      params: resourceParamsSchema,
    }
  }, async (request, reply) => {
    const deleted = feedManager.deleteFeed(request.params.name);
    if (deleted) {
      reply.status(204); // 204 No Content
      return;
    }
    reply.status(404).send({ message: `Feed with name '${request.params.name}' not found.` });
  });

  // GET /api/feeds/:name/start
  fastify.get<{ Params: { name: string }, Reply: { message: string } }>('/:name/start', {
    schema: {
      params: resourceParamsSchema,
    }
  }, async (request, reply) => {
    const started = feedManager.startFeed(request.params.name);
    if (started) {
      return { message: `Feed '${request.params.name}' started successfully.` };
    }

    const config = feedManager.getFeedConfigByName(request.params.name);
    if (!config) {
      reply.status(404).send({ message: `Feed with name '${request.params.name}' not found.` });
    }
    reply.status(400).send({ message: `Failed to start feed '${request.params.name}'. Check logs for details (e.g., already running, no webhooks, or poller error).` });
  });

  // GET /api/feeds/:name/stop
  fastify.get<{ Params: { name: string }, Reply: { message: string } }>('/:name/stop', {
    schema: {
      params: resourceParamsSchema,
    }
  }, async (request, reply) => {
    const stopped = feedManager.stopFeed(request.params.name);

    const config = feedManager.getFeedConfigByName(request.params.name);
    if (!config) {
      reply.status(404).send({ message: `Feed with name '${request.params.name}' not found.` });
    }

    if (stopped) {
      return { message: `Feed '${request.params.name}' stopped successfully.` };
    }
    // If the feed exists but wasn't running, we return a non-error success message.
    return { message: `Feed '${request.params.name}' was already stopped.` };
  });

  // GET /api/feeds/:name/last-id
  fastify.get<{ Params: { name: string }, Reply: number }>('/:name/last-id', {
    schema: {
      params: resourceParamsSchema,
    }
  }, async (request, reply) => {
    const lastId = feedManager.getFeedLastId(request.params.name);

    if (lastId !== -1) {
      return lastId;
    }

    reply.status(404).send({ message: `Feed with name '${request.params.name}' not found.` });
  });

  // PATCH /api/feeds/:name/last-id
  fastify.patch<{ Params: { name: string }, Body: { lastId: number }, Reply: { message: string } }>('/:name/last-id', {
    schema: {
      params: resourceParamsSchema,
      body: feedLastIdUpdateBodySchema,
    }
  }, async (request, reply) => {
    const success = feedManager.updateFeedLastId(request.params.name, request.body.lastId);

    if (success) {
      return { message: `Successfully updated last_id for feed '${request.params.name}' to ${request.body.lastId}.` };
    }

    reply.status(404).send({ message: `Feed with name '${request.params.name}' not found.` });
  });
};
