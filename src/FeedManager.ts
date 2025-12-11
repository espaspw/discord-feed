import Database from 'better-sqlite3';
import { DanbooruPoller } from './DanbooruPoller';
import { DiscordFeed } from './DiscordFeed';
import { EventBus } from './EventBus';
import { DedupeCache } from './DedupeCache';
import type { ResolvedFeedConfig, FeedConfig, WebhookDestination } from './types';
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
  private dedupeCache: DedupeCache;

  private activeFeeds: Map<string, DiscordFeed> = new Map();
  private webhookCache: Map<string, number> = new Map();

  constructor(dbPath: string, poller: DanbooruPoller, eventBus: EventBus) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.poller = poller;
    this.eventBus = eventBus;
    this.dedupeCache = new DedupeCache();
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
        batchSize INTEGER,
        username TEXT,
        avatarUrl TEXT
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

  public createWebhook(webhook: WebhookDestination): WebhookDestination {
    const existingWebhook = this.getWebhookIdByUrl(webhook.url);
    if (existingWebhook) {
      throw new Error(`Webhook with URL '${webhook.url}' already exists.`);
    }

    const stmt = this.db.prepare(`
      INSERT INTO webhooks (name, url) VALUES (?, ?) 
    `);

    // Check if name already exists
    const existingName = this.db.prepare('SELECT 1 FROM webhooks WHERE name = ?').get(webhook.name);
    if (existingName) {
      throw new Error(`Webhook with name '${webhook.name}' already exists.`);
    }

    stmt.run(webhook.name, webhook.url);
    this.initializeWebhookCache(); // Update cache
    console.log(`[FeedManager] Created new webhook: ${webhook.name} (${webhook.url})`);
    return webhook;
  }

  public updateWebhook(name: string, newWebhook: WebhookDestination): WebhookDestination {
    const existingWebhook = this.db.prepare('SELECT id, url FROM webhooks WHERE name = ?').get(name) as { id: number, url: string } | undefined;
    if (!existingWebhook) {
      throw new Error(`Webhook with name '${name}' not found.`);
    }

    // Check if a webhook with the new URL or new name already exists (unless it's the same webhook)
    const urlCheck = this.db.prepare('SELECT id FROM webhooks WHERE url = ? AND id != ?').get(newWebhook.url, existingWebhook.id);
    if (urlCheck) {
      throw new Error(`Webhook with URL '${newWebhook.url}' already exists.`);
    }
    const nameCheck = this.db.prepare('SELECT id FROM webhooks WHERE name = ? AND id != ?').get(newWebhook.name, existingWebhook.id);
    if (nameCheck) {
      throw new Error(`Webhook with name '${newWebhook.name}' already exists.`);
    }

    const stmt = this.db.prepare('UPDATE webhooks SET name = ?, url = ? WHERE id = ?');
    const result = stmt.run(newWebhook.name, newWebhook.url, existingWebhook.id);

    if (result.changes === 0) {
      throw new Error(`Failed to update webhook '${name}'.`);
    }

    this.initializeWebhookCache();
    console.log(`[FeedManager] Updated webhook: ${name} -> ${newWebhook.name} (${newWebhook.url})`);
    return newWebhook;
  }

  public deleteWebhook(name: string): boolean {
    const existing = this.db.prepare('SELECT id FROM webhooks WHERE name = ?').get(name) as { id: number } | undefined;
    if (!existing) {
      console.warn(`[FeedManager] Cannot delete webhook: Name ${name} not found in DB.`);
      return false;
    }

    // Deleting the webhook will automatically delete all entries in feeds_to_webhooks due to ON DELETE CASCADE
    const stmt = this.db.prepare('DELETE FROM webhooks WHERE id = ?');
    const result = stmt.run(existing.id);

    if (result.changes > 0) {
      this.initializeWebhookCache();
      console.log(`[FeedManager] Deleted webhook: ${name}.`);
    }

    return result.changes > 0;
  }

  public getAllWebhooks(): WebhookDestination[] {
    const stmt = this.db.prepare('SELECT name, url FROM webhooks');
    return stmt.all() as WebhookDestination[];
  }

  private getWebhookIdByName(name: string): number | undefined {
    const stmt = this.db.prepare('SELECT id FROM webhooks WHERE name = ?');
    const row = stmt.get(name) as { id: number } | undefined;
    return row?.id;
  }

  private getWebhookIdByUrl(url: string): number | undefined {
    if (this.webhookCache.has(url)) {
      return this.webhookCache.get(url)!;
    }
    const selectStmt = this.db.prepare('SELECT id FROM webhooks WHERE url = ?');
    const row = selectStmt.get(url) as { id: number } | undefined;
    if (row) {
      this.webhookCache.set(url, row.id);
      return row.id;
    }
    return undefined;
  }

  private createResolvedFeedConfig(row: any, webhooks: WebhookDestination[]): ResolvedFeedConfig {
    return {
      name: row.name,
      tags: parseJson(row.tags),
      webhookDestinations: webhooks,
      pollingIntervalMs: row.pollingIntervalMs,
      batchSize: row.batchSize,
      username: row.username,
      avatarUrl: row.avatarUrl,
    };
  }

  public getAllFeedsFromDb(): (ResolvedFeedConfig & { id: number, isRunning: boolean })[] {
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
      const config = this.createResolvedFeedConfig(row, webhooks);

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

    const webhookIds: number[] = [];
    for (const webhookName of config.webhookNames) {
      const webhookId = this.getWebhookIdByName(webhookName);
      if (!webhookId) {
        throw new Error(`Cannot create feed '${config.name}'. Webhook with name '${webhookName}' not found.`);
      }
      webhookIds.push(webhookId);
    }

    const insertFeedStmt = this.db.prepare(`
      INSERT INTO feeds (name, tags, pollingIntervalMs, batchSize, username, avatarUrl) 
      VALUES (?, ?, ?, ?, ?, ?)
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
        config.username ?? null,
        config.avatarUrl ?? null,
      );
      const feedId = Number(result.lastInsertRowid);

      for (const webhookId of webhookIds) {
        insertJunctionStmt.run(feedId, webhookId);
      }
    })();

    console.log(`[FeedManager] Created new feed: ${config.name}`);
    return config;
  }

  public updateFeed(oldName: string, newConfig: Partial<FeedConfig>): ResolvedFeedConfig {
    const existingFeedRow = this.db.prepare('SELECT id FROM feeds WHERE name = ?').get(oldName) as { id: number } | undefined;
    if (!existingFeedRow) {
      throw new Error(`Feed with name '${oldName}' not found.`);
    }
    const feedId = existingFeedRow.id;
    let finalName = oldName;

    let updateFields: string[] = [];
    let updateValues: any[] = [];

    // If name is updated, check for uniqueness of the new name
    if (newConfig.name && newConfig.name !== oldName) {
      const existingNameCheck = this.db.prepare('SELECT 1 FROM feeds WHERE name = ?').get(newConfig.name);
      if (existingNameCheck) {
        throw new Error(`Feed with name '${newConfig.name}' already exists. Cannot update.`);
      }
      updateFields.push('name = ?');
      updateValues.push(newConfig.name);
      finalName = newConfig.name;
    }

    if (newConfig.tags) {
      updateFields.push('tags = ?');
      updateValues.push(JSON.stringify(newConfig.tags));
    }
    if (newConfig.pollingIntervalMs) {
      updateFields.push('pollingIntervalMs = ?');
      updateValues.push(newConfig.pollingIntervalMs);
    }
    if (newConfig.batchSize) {
      updateFields.push('batchSize = ?');
      updateValues.push(newConfig.batchSize);
    }
    if (newConfig.username !== undefined) {
      updateFields.push('username = ?');
      updateValues.push(newConfig.username);
    }
    if (newConfig.avatarUrl !== undefined) {
      updateFields.push('avatarUrl = ?');
      updateValues.push(newConfig.avatarUrl);
    }

    if (updateFields.length > 0) {
      const updateStmt = this.db.prepare(`UPDATE feeds SET ${updateFields.join(', ')} WHERE id = ?`);
      updateStmt.run(...updateValues, feedId);
    }

    // Update webhook joins
    if (newConfig.webhookNames) {
      const newWebhookIds: number[] = [];
      for (const webhookName of newConfig.webhookNames) {
        const webhookId = this.getWebhookIdByName(webhookName);
        if (!webhookId) {
          throw new Error(`Cannot update feed '${finalName}'. Webhook with name '${webhookName}' not found.`);
        }
        newWebhookIds.push(webhookId);
      }

      this.db.transaction(() => {
        this.db.prepare('DELETE FROM feeds_to_webhooks WHERE feed_id = ?').run(feedId);

        const insertJunctionStmt = this.db.prepare(`
          INSERT INTO feeds_to_webhooks (feed_id, webhook_id) VALUES (?, ?)
        `);
        for (const webhookId of newWebhookIds) {
          insertJunctionStmt.run(feedId, webhookId);
        }
      })();
    }

    // Stop and restart the feed if it was active and the config changed.
    const wasRunning = this.activeFeeds.has(oldName);
    if (wasRunning) {
      this.stopFeed(oldName);
    }

    const resolvedConfig = this.getResolvedFeedConfigByName(finalName)!;

    if (wasRunning) {
      this.startFeed(finalName);
    }

    console.log(`[FeedManager] Updated feed: ${oldName} -> ${finalName}`);
    return resolvedConfig;
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

    const config = this.getResolvedFeedConfigByName(name);
    if (!config) {
      console.error(`[FeedManager] Failed to start feed: Configuration for '${name}' not found.`);
      return false;
    }

    if (config.webhookDestinations.length === 0) {
      console.error(`[FeedManager] Failed to start feed: No webhooks found for '${name}'.`);
      return false;
    }

    const tagKey = getTagKey(config.tags);

    this.poller.addFeed(config);
    const pollerStarted = this.poller.startFeed(tagKey);

    if (!pollerStarted) {
      console.error(`[FeedManager] Failed to start poller for tagKey: ${tagKey}.`);
      return false;
    }

    const discordFeed = new DiscordFeed(this.eventBus, config, this.dedupeCache);
    this.activeFeeds.set(name, discordFeed);

    console.log(`[FeedManager] Started polling and Discord subscription for '${name}'.`);
    return true;
  }

  public stopFeed(name: string): boolean {
    if (!this.activeFeeds.has(name)) {
      console.log(`[FeedManager] Feed '${name}' is already stopped.`);
      return false;
    }

    const config = this.getResolvedFeedConfigByName(name);
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

  public startAllFeeds() {
    console.log('[FeedManager] Loading and starting all configured feeds...');
    const feeds = this.getAllFeedsFromDb();

    for (const feed of feeds) {
      this.poller.addFeed(feed);
      this.startFeed(feed.name);
    }
    console.log(`[FeedManager] Successfully initialized ${this.activeFeeds.size} active feeds.`);
  }

  public getFeedLastId(name: string): number {
    const config = this.getFeedConfigByName(name);
    if (!config) {
      console.warn(`[FeedManager] Feed '${name}' not found.`);
      return -1;
    }

    const tagKey = getTagKey(config.tags);
    return this.poller.getLastIdForTag(tagKey);
  }

  public updateFeedLastId(name: string, newLastId: number): boolean {
    const config = this.getFeedConfigByName(name);
    if (!config) {
      console.warn(`[FeedManager] Cannot update last_id: Feed '${name}' not found.`);
      return false;
    }

    const tagKey = getTagKey(config.tags);
    this.poller.saveLastIdForTag(tagKey, newLastId);

    console.log(`[FeedManager] Manually updated last_id for feed '${name}' (TagKey: ${tagKey}) to ${newLastId}.`);
    return true;
  }

  public getFeedConfigByName(name: string): (FeedConfig & { id: number }) | undefined {
    const row = this.db.prepare('SELECT * FROM feeds WHERE name = ?').get(name) as any;
    if (!row) return undefined;

    const webhooksQuery = this.db.prepare(`
      SELECT w.name
      FROM webhooks w 
      JOIN feeds_to_webhooks fw ON w.id = fw.webhook_id 
      WHERE fw.feed_id = ?
    `);
    const webhookRows = webhooksQuery.all(row.id) as { name: string }[];
    const webhookNames = webhookRows.map(r => r.name);

    return {
      name: row.name,
      tags: parseJson(row.tags),
      webhookNames,
      pollingIntervalMs: row.pollingIntervalMs,
      batchSize: row.batchSize,
      username: row.username,
      avatarUrl: row.avatarUrl,
      id: row.id,
    };
  }

  private getResolvedFeedConfigByName(name: string): (ResolvedFeedConfig & { id: number }) | undefined {
    const row = this.db.prepare('SELECT * FROM feeds WHERE name = ?').get(name) as any;
    if (!row) return undefined;

    const webhooksQuery = this.db.prepare(`
      SELECT w.name, w.url 
      FROM webhooks w 
      JOIN feeds_to_webhooks fw ON w.id = fw.webhook_id 
      WHERE fw.feed_id = ?
    `);
    const webhooks = webhooksQuery.all(row.id) as WebhookDestination[];

    const resolvedConfig = this.createResolvedFeedConfig(row, webhooks);
    return { ...resolvedConfig, id: row.id };
  }
}