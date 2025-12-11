import axios from 'axios';
import Database from 'better-sqlite3';

import { EventBus } from './EventBus';
import type { TagConfig, ResolvedFeedConfig, RawDanbooruPost, DanbooruImage } from './types';
import { getTagKey, checkFieldsAreDefined, makeReadableList, cleanUpTags, formatBytes } from './util';

export class DanbooruPoller {
  private eventBus: EventBus;
  private danbooruApiKey: string;
  private danbooruApiUser: string;
  private isInitialized: boolean = false;

  private tagConfigs: Map<string, TagConfig> = new Map();
  private activeTagTimers: Map<string, NodeJS.Timeout> = new Map();
  private db: Database | null = null;
  private dbPath: string = 'db/data.db';
  private baseEndpoint: string = 'https://danbooru.donmai.us';

  constructor(
    eventBus: EventBus,
    apiKey: string,
    apiUser: string,
  ) {
    this.eventBus = eventBus;
    this.danbooruApiKey = apiKey;
    this.danbooruApiUser = apiUser;
  }

  init() {
    this.initializeDatabase();
    console.log('[Poller] Database initialized successfully.');
    this.isInitialized = true;
  }

  addFeed(feedConfig: ResolvedFeedConfig): string {
    if (!this.isInitialized) {
      throw new Error('[Poller Error] Poller must be initialized before starting feeds.');
    }

    const tagKey = getTagKey(feedConfig.tags);
    const newInterval = feedConfig.pollingIntervalMs ?? 30000;
    const batchSize = feedConfig.batchSize ?? 3;

    const existingTimer = this.activeTagTimers.get(tagKey);
    this.tagConfigs.set(tagKey, { pollIntervalMs: newInterval, batchSize: batchSize });
    console.log(`[Poller] Adding feed with tag key '${tagKey}' with interval ${newInterval}ms.`);
    return tagKey;
  }

  removeFeed(tagKey: string): boolean {
    if (!this.tagConfigs.has(tagKey)) {
      console.log(`[Poller] Couldn't find feed with tag key: ${tagKey}.`);
      return false;
    }
    if (this.activeTagTimers.has(tagKey)) {
      this.stopPollLoop(tagKey);
    }
    this.tagConfigs.delete(tagKey);
    console.log(`[Poller] Stopped and removed timer for tag key: ${tagKey}.`);
    return true;
  }

  startFeed(tagKey: string): boolean {
    if (!this.isInitialized) {
      throw new Error('[Poller Error] Called startFeed before initializing poller.');
    }
    const config = this.tagConfigs.get(tagKey);
    if (!config) return false;
    if (this.activeTagTimers.has(tagKey)) {
      `[Poller] Feed with tag key: ${tagKey} already running, skipping.`
      return false;
    }
    console.log(`[Poller] Starting feed with tag key: ${tagKey}.`);
    this.startPollLoop(tagKey, config.pollIntervalMs);
    return true;
  }

  stopFeed(tagKey: string): boolean {
    if (!this.activeTagTimers.has(tagKey)) {
      return false;
    }
    this.stopPollLoop(tagKey);
    return true;
  }

  startAllFeeds(): void {
    console.log(this.tagConfigs)
    for (const tagKey of this.tagConfigs.keys()) {
      this.startFeed(tagKey);
    }
  }

  stopAllFeeds(): void {
    for (const tagKey of this.activeTagTimers.keys()) {
      this.stopFeed(tagKey);
    }
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

  private stopPollLoop(tagKey: string) {
    const timerId = this.activeTagTimers.get(tagKey)
    if (!timerId) return;
    clearInterval(timerId);
    this.activeTagTimers.delete(tagKey)
    console.log(`[Poller] Stopped timer for tag key: ${tagKey}`);
  }

  private async pollTag(tagKey: string) {
    const tagConfig = this.tagConfigs.get(tagKey);

    if (!tagConfig) {
      throw new Error(`Failed to find tag config for tag key ${tagKey}.`);
    }

    const lastId = this.getLastIdForTag(tagKey);
    console.log(`[Poller] Fetching new images for tag '${tagKey}' since ID ${lastId}...`);

    const apiTags = [...tagKey.split('+'), 'order:id', `id:>${lastId}`].join(' ');

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

  private initializeDatabase() {
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
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

  public getLastIdForTag(tagKey: string): Promise<number> {
    if (!this.db) return 0;
    const statement = this.db.prepare('SELECT last_image_id FROM last_ids WHERE tag_key = ?');
    const result = statement.get<{ last_image_id: number; }>(tagKey);
    return result?.last_image_id ?? 0;
  }

  public saveLastIdForTag(tagKey: string, id: number): Promise<void> {
    if (!this.db) return;

    const statement = this.db.prepare(`INSERT INTO last_ids (tag_key, last_image_id) 
        VALUES (?, ?) 
        ON CONFLICT(tag_key) DO UPDATE SET last_image_id = excluded.last_image_id`);
    this.db.transaction(([tagKey, id]) => statement.run(tagKey, id))([tagKey, id]);
  }

  private parseDanbooruPost(post: RawDanbooruPost): DanbooruImage {
    const expectedFields = ['id', 'rating', 'tag_string_artist', 'tag_string_character', 'tag_string_general', 'tag_string_copyright', 'file_ext', 'file_size'] as (keyof RawDanbooruPost)[];
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
