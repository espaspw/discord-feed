import type { FeedConfig } from './types';
import { EventBus } from './EventBus';
import { DanbooruPoller } from './DanbooruPoller';
import { DiscordFeed } from './DiscordFeed';

async function main() {
  const DANBOORU_API_KEY = process.env.DANBOORU_API_KEY || '';
  const DANBOORU_API_USER = process.env.DANBOORU_API_USER || '';

  if (DANBOORU_API_KEY === '' || DANBOORU_API_USER === '') {
    console.warn('WARNING: Danbooru API Key or User not set. Polling might be severely rate-limited or fail. Please set DANBOORU_API_KEY and DANBOORU_API_USER environment variables.');
  }

  const eventBus = new EventBus();
  const feedConfig: FeedConfig = {
    name: 'test-feed',
    tags: ['blue_archive'],
    webhookDestinations: [{ name: 'test', url: 'https://discord.com/api/webhooks/1398160813029851147/7Kz_XExS-QZTCVJ2He5Qf5Uk_sjwpvGPFlb0t8fsy8SIin2cyygjQHk5V3G2r0LrVUqd' }],
    batchSize: 3,
  };


  // Initialize the Poller
  const poller = new DanbooruPoller(
    eventBus,
    DANBOORU_API_KEY,
    DANBOORU_API_USER,
  );

  const discordFeeds = [new DiscordFeed(eventBus, feedConfig)];

  poller.init();
  const tagKey = poller.addFeed(feedConfig);
  poller.startAllFeeds()

  // Handle graceful shutdown
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