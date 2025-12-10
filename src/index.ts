import type { FeedConfig } from './types';
import { EventBus } from './EventBus';
import { DanbooruPoller } from './DanbooruPoller';
import { DiscordFeed } from './DiscordFeed';
import { FeedManager } from './FeedManager';

import { buildServer } from './server/server'

async function main() {
  const DANBOORU_API_KEY = process.env.DANBOORU_API_KEY || '';
  const DANBOORU_API_USER = process.env.DANBOORU_API_USER || '';

  if (DANBOORU_API_KEY === '' || DANBOORU_API_USER === '') {
    console.warn('WARNING: Danbooru API Key or User not set. Polling might be severely rate-limited or fail. Please set DANBOORU_API_KEY and DANBOORU_API_USER environment variables.');
  }

  const eventBus = new EventBus();
  const poller = new DanbooruPoller(
    eventBus,
    DANBOORU_API_KEY,
    DANBOORU_API_USER,
  );

  poller.init();

  const feedManager = new FeedManager('db/data.db', poller, eventBus);
  feedManager.initDb();

  const server = buildServer({ feedManager })
  server.listen({ port: 3001, host: '0.0.0.0' }, (err, address) => {
    if (err) throw err;
    console.log(`[App] Server started on port ${3001}.`);
  });

  process.on('SIGINT', async () => {
    console.log('\n[App] SIGINT received, stopping polling...');
    poller.stopAllFeeds();
    console.log('[App] Application shutting down.');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Unhandled application error:', err);
  process.exit(1);
});