import axios from 'axios';
import Database from 'better-sqlite3';

import { EventBus } from './EventBus';
import type { TagConfig, FeedConfig, RawDanbooruPost, DanbooruImage } from './types';
import { getTagKey, checkFieldsAreDefined, makeReadableList, cleanUpTags, formatBytes } from './util';

export class DanbooruPoller {
  private eventBus: EventBus;
  private danbooruApiKey: string; // Replace with actual API key/user for higher rate limits
  private danbooruApiUser: string;
  private isInitialized: boolean = false;

  private tagConfigs: Map<string, TagConfig> = new Map();
  private activeTagTimers: Map<string, NodeJS.Timeout> = new Map();
  private db: Database | null = null;
  private dbPath: string = 'db/data.db';
  private baseEndpoint: string = 'https://testbooru.donmai.us';

  constructor(
    eventBus: EventBus,
    apiKey: string,
    apiUser: string,
    feedConfigs: FeedConfig[]
  ) {
    this.eventBus = eventBus;
    this.danbooruApiKey = apiKey;
    this.danbooruApiUser = apiUser;
    this.addFeedConfigs(feedConfigs);
  }

  private addFeedConfigs(feedConfigs: FeedConfig[]) {
    for (const feedConfig of feedConfigs) {
      const newInterval = feedConfig.pollingIntervalMs ?? 30000; // Defaults to 5 minutes.
      const tagKey = getTagKey(feedConfig.tags);
      const existingInterval = this.tagConfigs.get(tagKey)?.pollIntervalMs;
      if (existingInterval && existingInterval < newInterval) {
        console.log(`[Poller] Coalescing pollers for '${feedConfig.name}' with existing feed with same tag key '${tagKey}'.`);
      } else {
        this.tagConfigs.set(tagKey, { pollIntervalMs: newInterval, batchSize: feedConfig?.batchSize ?? 3 });
        console.log(`[Poller] Set polling interval for tag key '${tagKey}' to ${newInterval}ms.`);
      }
    }
  }

  private async initializeDatabase() {
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS last_ids (
          tag_key TEXT PRIMARY KEY,
          last_image_id INTEGER
        )
      `);
      console.log('[Poller] SQLite database ready and table verified.');
    } catch (error) {
      console.error('[Poller Error] Failed to initialize SQLite database:', error);
      throw new Error('Database initialization failed.');
    }
  }

  async init() {
    await this.initializeDatabase();
    console.log('[Poller] Database initialized successfully.');
    this.isInitialized = true;
  }

  startPolling() {
    if (!this.isInitialized) {
      throw new Error('[Poller Error] Called startPolling before initializing poller.');
    }
    if (this.activeTagTimers.size > 0) {
      console.log('[Poller] Polling already started.');
      return;
    }
    console.log('[Poller] Starting polling for all feeds...');
    for (const [tagKey, config] of this.tagConfigs.entries()) {
      const pollingIntervalMs = config?.pollIntervalMs ?? 300000; // default to 5 minutes
      this.startPollLoop(tagKey, pollingIntervalMs);
    }
  }

  stopPolling() {
    console.log('[Poller] Stopping all active polling timers...');
    for (const [tagKey, timerId] of this.activeTagTimers.entries()) {
      clearInterval(timerId);
      console.log(`[Poller] Stopped timer for tag key: ${tagKey}`);
    }
    this.activeTagTimers.clear();
  }

  private startPollLoop(tagKey: string, intervalMs: number) {
    this.pollTag(tagKey).catch(err => {
      console.error(`[Poller Error] Initial poll failed for ${tagKey}:`, err);
    });

    const timerId = setInterval(() => {
      this.pollTag(tagKey).catch(err => {
        console.error(`[Poller Error] Scheduled poll failed for ${tagKey}:`, err);
      });
    }, intervalMs);

    this.activeTagTimers.set(tagKey, timerId);
  }

  private async pollTag(tagKey: string) {
    const tagConfig = this.tagConfigs.get(tagKey);

    if (!tagConfig) {
      throw new Error(`Failed to find tag config for tag key ${tagKey}.`);
    }

    const lastId = await this.getLastIdForTag(tagKey);
    console.log(`[Poller] Fetching new images for tag '${tagKey}' since ID ${lastId}...`);

    const apiTags = [...tagKey.split(','), 'order:id', `id:>${lastId}`].join(' ');

    try {
      const response = await axios.get<RawDanbooruPost[]>(`${this.baseEndpoint}/posts.json`, {
        params: {
          tags: apiTags,
          limit: tagConfig.batchSize,
        },
      });

      const rawPosts = response.data.filter(img => img.id > lastId).sort((a, b) => a.id - b.id);

      if (rawPosts.length > 0) {
        console.log(`[Poller] Found ${rawPosts.length} new images for tag '${tagKey}'.`);
        let maxId = lastId;
        for (const post of rawPosts) {
          this.eventBus.emitNewImage(tagKey, this.parseDanbooruPost(post));
          if (post.id > maxId) {
            maxId = post.id;
          }
        }
        this.saveLastIdForTag(tagKey, maxId);
      } else {
        console.log(`[Poller] No new images found for tag '${tagKey}'.`);
      }
    } catch (error: any) {
      console.error(`[Poller Error] Failed to poll tag '${tagKey}':`, error.message);
      if (error.response) {
        console.error('Response data:', error.response.data);
        console.error('Response status:', error.response.status);
      }
    }
  }

  private async getLastIdForTag(tagKey: string): Promise<number> {
    if (!this.db) return 0;
    const statement = await this.db.prepare('SELECT last_image_id FROM last_ids WHERE tag_key = ?');
    const result = await statement.get<{ last_image_id: number; }>(tagKey);
    return result?.last_image_id ?? 0;
  }

  private async saveLastIdForTag(tagKey: string, id: number): Promise<void> {
    if (!this.db) return;

    // Uses a transaction to ensure atomicity
    const statement = this.db.prepare(`INSERT INTO last_ids (tag_key, last_image_id) 
        VALUES (?, ?) 
        ON CONFLICT(tag_key) DO UPDATE SET last_image_id = excluded.last_image_id`);
    await this.db.transaction(([tagKey, id]) => statement.run(tagKey, id))([tagKey, id]);
  }

  private parseDanbooruPost(post: RawDanbooruPost): DanbooruImage {
    const expectedFields = ['id', 'rating', 'tag_string_artist', 'tag_string_character', 'tag_string_general', 'tag_string_copyright', 'file_ext', 'file_size'] as (keyof UncheckedBasePostApiResult)[];
    checkFieldsAreDefined(post, expectedFields);

    const artists = post.tag_string_artist.split(' ').filter((x: string) => x !== '');
    const characters = post.tag_string_character.split(' ').filter((x: string) => x !== '');
    const tags = post.tag_string_general.split(' ').filter((x: string) => x !== '');
    const origin = post.tag_string_copyright.split(' ').filter((x: string) => x !== '');
    const height = post?.image_height ?? 'Unknown'
    const width = post?.image_width ?? 'Unknown'
    return {
      id: post.id,
      rating: post.rating,
      source: post?.source ?? null,
      artists,
      characters,
      tags,
      origin,
      createdAt: post?.created_at ?? (new Date()).toISOString(),
      height,
      width,
      fileUrl: post?.file_url ?? null,
      previewUrl: post?.preview_file_url ?? null,
      fileExt: post.file_ext,
      fileSize: post.file_size,
      isBanned: post.is_banned ?? false,
      isDeleted: post.is_deleted ?? false,
      isPending: post.is_pending ?? false,
      isFlagged: post.is_flagged ?? false,
      readableArtists: makeReadableList(cleanUpTags(artists)),
      readableCharacters: makeReadableList(cleanUpTags(characters)),
      readableOrigin: makeReadableList(cleanUpTags(origin)),
      readableFileSize: formatBytes(post.file_size),
      postUrl: `${this.baseEndpoint}/posts/${post.id}`,
      artistUrl: `${this.baseEndpoint}/posts?tags=${artists.join('+')}`,
      dimensions: `${width} × ${height}`,
    };
  }
}
