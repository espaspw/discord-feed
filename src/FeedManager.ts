import Database from 'better-sqlite3';
import { DanbooruPoller } from './DanbooruPoller';
import { DiscordFeed } from './DiscordFeed';
import { EventBus } from './EventBus';
import type { FeedConfig, WebhookDestination } from './types';
import { getTagKey } from './util';

const parseJson = (jsonString: string): any => {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error('Failed to parse JSON from DB for tags:', jsonString, e);
    return [];
  }
};

export class FeedManager {
  private db: Database;
  private poller: DanbooruPoller;
  private eventBus: EventBus;

  private activeFeeds: Map<string, DiscordFeed> = new Map();
  private webhookCache: Map<string, number> = new Map();

  constructor(dbPath: string, poller: DanbooruPoller, eventBus: EventBus) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.poller = poller;
    this.eventBus = eventBus;
  }

  initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT UNIQUE NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        tags TEXT NOT NULL,
        pollingIntervalMs INTEGER,
        batchSize INTEGER
      )
    `);

    this.db.exec(`
        CREATE TABLE IF NOT EXISTS feeds_to_webhooks (
          feed_id INTEGER NOT NULL,
          webhook_id INTEGER NOT NULL,
          PRIMARY KEY (feed_id, webhook_id),
          FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
          FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
        )
    `);
  }

  private initializeWebhookCache() {
    const stmt = this.db.prepare('SELECT id, url FROM webhooks');
    const rows = stmt.all() as { id: number, url: string }[];
    rows.forEach(row => this.webhookCache.set(row.url, row.id));
    console.log(`[FeedManager] Webhook cache initialized with ${this.webhookCache.size} webhooks.`);
  }

  private findOrCreateWebhook(url: string, name: string): number {
    if (this.webhookCache.has(url)) {
      return this.webhookCache.get(url)!;
    }

    const stmt = this.db.prepare(`
      INSERT INTO webhooks (name, url) VALUES (?, ?) 
      ON CONFLICT(url) DO UPDATE SET name=excluded.name 
      RETURNING id
    `);

    const result = stmt.run(name, url);
    let webhookId: number;
    if (result.lastInsertRowid) {
      webhookId = Number(result.lastInsertRowid);
    } else {
      const selectStmt = this.db.prepare('SELECT id FROM webhooks WHERE url = ?');
      webhookId = (selectStmt.get(url) as { id: number }).id;
    }

    this.webhookCache.set(url, webhookId);
    return webhookId;
  }

  private createFeedConfig(row: any, webhooks: WebhookDestination[]): FeedConfig {
    return {
      name: row.name,
      tags: parseJson(row.tags),
      webhookDestinations: webhooks,
      pollingIntervalMs: row.pollingIntervalMs,
      batchSize: row.batchSize,
    };
  }

  public getAllFeedsFromDb(): (FeedConfig & { id: number, isRunning: boolean })[] {
    const feedsStmt = this.db.prepare('SELECT * FROM feeds');
    const feedRows = feedsStmt.all() as any[];
    const mappingStmt = this.db.prepare(`
      SELECT 
        f.id AS feed_id, 
        w.name AS webhook_name, 
        w.url AS webhook_url
      FROM feeds f
      JOIN feeds_to_webhooks fw ON f.id = fw.feed_id
      JOIN webhooks w ON fw.webhook_id = w.id
    `);
    const mappingRows = mappingStmt.all() as any[];

    const webhooksByFeedId = mappingRows.reduce((acc, row) => {
      if (!acc[row.feed_id]) {
        acc[row.feed_id] = [];
      }
      acc[row.feed_id].push({ name: row.webhook_name, url: row.webhook_url });
      return acc;
    }, {} as Record<number, WebhookDestination[]>);

    return feedRows.map(row => {
      const webhooks = webhooksByFeedId[row.id] || [];
      const config = this.createFeedConfig(row, webhooks);

      return {
        ...config,
        isRunning: this.activeFeeds.has(config.name),
        id: row.id,
      };
    });
  }

  public createFeed(config: FeedConfig): FeedConfig {
    const existingFeed = this.db.prepare('SELECT 1 FROM feeds WHERE name = ?').get(config.name);
    if (existingFeed) {
      throw new Error(`Feed with name '${config.name}' already exists.`);
    }

    const insertFeedStmt = this.db.prepare(`
      INSERT INTO feeds (name, tags, pollingIntervalMs, batchSize) 
      VALUES (?, ?, ?, ?)
    `);

    const insertJunctionStmt = this.db.prepare(`
      INSERT INTO feeds_to_webhooks (feed_id, webhook_id) VALUES (?, ?)
    `);

    this.db.transaction(() => {
      const result = insertFeedStmt.run(
        config.name,
        JSON.stringify(config.tags),
        config.pollingIntervalMs,
        config.batchSize,
      );
      const feedId = Number(result.lastInsertRowid);

      for (const webhook of config.webhookDestinations) {
        const webhookId = this.findOrCreateWebhook(webhook.url, webhook.name);
        insertJunctionStmt.run(feedId, webhookId);
      }
    })();

    console.log(`[FeedManager] Created and started new feed: ${config.name}`);
    return config.name;
  }

  public deleteFeed(name: string): boolean {
    const feedRow = this.db.prepare('SELECT id, tags FROM feeds WHERE name = ?').get(name) as { id: number, tags: string } | undefined;

    if (!feedRow) {
      console.warn(`[FeedManager] Cannot delete feed: Name ${name} not found in DB.`);
      return false;
    }

    this.stopFeed(name);

    const deleteStmt = this.db.prepare('DELETE FROM feeds WHERE id = ?');
    const result = deleteStmt.run(feedRow.id);

    return result.changes > 0;
  }

  public startFeed(name: string): boolean {
    if (this.activeFeeds.has(name)) {
      console.log(`[FeedManager] Feed '${name}' is already running.`);
      return true;
    }

    const config = this.getFeedConfigByName(name);
    if (!config) {
      console.error(`[FeedManager] Failed to start feed: Configuration for '${name}' not found.`);
      return false;
    }

    const tagKey = getTagKey(config.tags);

    this.poller.addFeed(config);
    const pollerStarted = this.poller.startFeed(tagKey);

    if (!pollerStarted) {
      console.error(`[FeedManager] Failed to start poller for tagKey: ${tagKey}.`);
      return false;
    }

    const discordFeed = new DiscordFeed(this.eventBus, config);
    this.activeFeeds.set(name, discordFeed);

    console.log(`[FeedManager] Started polling and Discord subscription for '${name}'.`);
    return true;
  }

  public stopFeed(name: string): boolean {
    if (!this.activeFeeds.has(name)) {
      console.log(`[FeedManager] Feed '${name}' is already stopped.`);
      return false;
    }

    const config = this.getFeedConfigByName(name);
    if (!config) {
      console.error(`[FeedManager] Cannot stop feed: Config for '${name}' not found.`);
      return false;
    }

    const tagKey = getTagKey(config.tags);

    const pollerStopped = this.poller.stopFeed(tagKey);

    const feedInstance = this.activeFeeds.get(name)!;
    feedInstance.unsubscribe();
    this.activeFeeds.delete(name);

    console.log(`[FeedManager] Stopped Discord subscription for '${name}'.`);
    return pollerStopped;
  }

  public initializeActiveFeeds() {
    console.log('[FeedManager] Loading and starting all configured feeds...');
    const feeds = this.getAllFeedsFromDb();

    for (const feed of feeds) {
      this.poller.addFeed(feed);
      this.startFeed(feed.name);
    }
    console.log(`[FeedManager] Successfully initialized ${this.activeFeeds.size} active feeds.`);
  }

  private getFeedConfigByName(name: string): (FeedConfig & { id: number }) | undefined {
    const row = this.db.prepare('SELECT * FROM feeds WHERE name = ?').get(name) as any;
    if (!row) return undefined;

    const webhooksQuery = this.db.prepare(`
      SELECT w.name, w.url 
      FROM webhooks w 
      JOIN feeds_to_webhooks fw ON w.id = fw.webhook_id 
      WHERE fw.feed_id = ?
    `);
    const webhooks = webhooksQuery.all(row.id) as WebhookDestination[];

    return this.createFeedConfig(row, webhooks);
  }
}