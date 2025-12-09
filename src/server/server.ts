import Fastify, { FastifyInstance } from 'fastify';

import { FeedManager } from '../FeedManager';
import { feedRoutes } from './feed-routes';
import { webhookRoutes } from './webhook-routes';

export function buildServer({ feedManager }: ServerOptions): FastifyInstance {
  const fastify = Fastify({ logger: true });

  fastify.decorate('feedManager', feedManager);

  fastify.register(webhookRoutes, { prefix: '/api/webhooks' });
  fastify.register(feedRoutes, { prefix: '/api/feeds' });

  return fastify;
}
