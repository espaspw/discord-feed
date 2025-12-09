import { FastifyPluginAsync } from 'fastify';

import { resourceParamsSchema, webhookBodySchema } from './schemas';
import { FeedManager } from '../FeedManager';
import { WebhookDestination } from '../types';

export const webhookRoutes: FastifyPluginAsync = async (fastify, opts) => {
  const feedManager = fastify.feedManager as FeedManager;

  // GET /api/webhooks
  fastify.get<{ Reply: WebhookDestination[] }>('/', async (request, reply) => {
    return feedManager.getAllWebhooks();
  });

  // POST /api/webhooks
  fastify.post<{ Body: WebhookDestination, Reply: WebhookDestination }>('/', {
    schema: {
      body: webhookBodySchema,
    }
  }, async (request, reply) => {
    try {
      const webhook = feedManager.createWebhook(request.body);
      reply.status(201); // 201 Created
      return webhook;
    } catch (error: any) {
      reply.status(400).send({ message: error.message });
    }
  });

  // PUT /api/webhooks/:name
  fastify.put<{ Params: { name: string }, Body: WebhookDestination, Reply: WebhookDestination }>('/:name', {
    schema: {
      params: resourceParamsSchema,
      body: webhookBodySchema,
    }
  }, async (request, reply) => {
    try {
      const updatedWebhook = feedManager.updateWebhook(request.params.name, request.body);
      return updatedWebhook;
    } catch (error: any) {
      reply.status(404).send({ message: error.message });
    }
  });

  // DELETE /api/webhooks/:name
  fastify.delete<{ Params: { name: string }, Reply: { message: string } | void }>('/:name', {
    schema: {
      params: resourceParamsSchema,
    }
  }, async (request, reply) => {
    const deleted = feedManager.deleteWebhook(request.params.name);
    if (deleted) {
      reply.status(204); // 204 No Content
      return;
    }
    reply.status(404).send({ message: `Webhook with name '${request.params.name}' not found.` });
  });
};
