export function checkFieldsAreDefined(obj: Record<string, any>, fields: string[]) {
	for (const field of fields) {
		if (obj[field] === undefined) throw new Error(`Field ${field} undefined`)
	}
}

export function formatBytes(bytes: number, decimals = 2) {
	if (!+bytes) return '0 Bytes'
	const k = 1024
	const dm = decimals < 0 ? 0 : decimals
	const sizes = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']
	const i = Math.floor(Math.log(bytes) / Math.log(k))
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

export function makeReadableList(list: string[]) {
	if (list.length === 0) return ''
	if (list.length === 1) return list[0]
	if (list.length === 2) return `${list[0]} and ${list[1]}`
	const copy = [...list]
	copy[copy.length - 1] = `and ${copy[copy.length - 1]}`
	return copy.join(', ')
}

export function capitalizeFirstLetter(token: string) {
	return token.charAt(0).toUpperCase() + token.slice(1);
}

export function truncateString(string: string, limit = 96) {
	if (string.length < limit) return string
	return string.slice(0, limit - 3) + '...'
}

interface WebhookDestination {
  name: string;
  url: string;
}

interface FeedConfig {
  name: string;
  tags: string[]; 
  webhookDestinations: WebhookDestination[];
  pollingIntervalMs: number;
  batchSize: number;
}

import { EventEmitter } from 'events';
import axios from 'axios';
import * as fs from 'fs/promises'; // For simple JSON persistence
import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';

import { type RESTPostAPIWebhookWithTokenJSONBody as DiscordWebhook } from 'discord.js'

class EventBus extends EventEmitter {
  emitNewImage(tagKey: string, image: DanbooruImage) {
    this.emit(`newImage:${tagKey}`, image);
    console.log(`[EventBus] Emitted new image for tag key: ${tagKey}, ID: ${image.id}`);
  }

  onNewImage(tagKey: string, listener: (image: DanbooruImage) => void) {
    this.on(`newImage:${tagKey}`, listener);
    console.log(`[EventBus] Subscribed to new images for tag key: ${tagKey}`);
  }
}

interface TagConfig {
  pollIntervalMs: number;
  batchSize: number;
}

function getTagKey(tags: string[]) {
  const sortedTags = tags.toSorted((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return sortedTags.join(',')
}

interface RawDanbooruPost {
  id: number;
  rating: string;
  source?: string;
  tag_string_artist: string;
  tag_string_character: string;
  tag_string_general: string;
  tag_string_copyright: string;
  created_at?: string;
  image_height?: number;
  image_width?: number;
  file_url?: string;
  preview_file_url?: string;
  file_ext: string;
  file_size: number;
  is_banned?: boolean;
  is_deleted?: boolean;
  is_pending?: boolean;
  is_flagged?: boolean;
}

interface DanbooruImage {
  id: number;
  rating: string;
  source: string | null;
  artists: string[];
  characters: string[];
  tags: string[];
  origin: string[];
  createdAt: string;
  height: number | string;
  width: number | string;
  fileUrl: string | null;
  previewUrl: string | null;
  fileExt: string;
  fileSize: number;
  isBanned: boolean;
  isDeleted: boolean;
  isPending: boolean;
  isFlagged: boolean;
  readonly readableArtists: string;
  readonly readableCharacters: string;
  readonly readableOrigin: string;
  readonly readableFileSize: string;
  readonly postUrl: string;
  readonly artistUrl: string;
  readonly dimensions: string;
}

function cleanUpTags(tags: string[]): string[] {
  const tagTokens = tags
    .map(tag => {
      if (tag.endsWith(')')) {
        tag = tag.slice(0, tag.lastIndexOf('(') - 1)
      }
      const tokens = tag.split('_').map(capitalizeFirstLetter)
      return tokens.join(' ')
    })
  return [...new Set(tagTokens)]
}

const baseEndpoint = 'https://danbooru.donmai.us'
class DanbooruPoller {
  private eventBus: EventBus;
  private danbooruApiKey: string; // Replace with actual API key/user for higher rate limits
  private danbooruApiUser: string;
  
  private tagConfigs: Map<string, TagConfig> = new Map();
  private activeTagTimers: Map<string, NodeJS.Timeout> = new Map(); 
  private db: Database | null = null;
  private dbPath: string = '/db/data.db';

  constructor(
    eventBus: EventBus,
    apiKey: string,
    apiUser: string,
    feedConfigs: FeedConfig[],
  ) {
    this.eventBus = eventBus;
    this.danbooruApiKey = apiKey;
    this.danbooruApiUser = apiUser;
    this.addFeedConfigs(feedConfigs);
    this.initializeDatabase().then(() => {
      console.log('[Poller] Database initialized successfully.');
    });
  }

  private addFeedConfigs(feedConfigs: FeedConfig[]) {
    for (const feedConfig of feedConfigs) {
      const newInterval = feedConfig.pollingIntervalMs ?? 30000; // Defaults to 5 minutes.
      const tagKey = getTagKey(feedConfig.tags)
      const existingInterval = this.tagConfigs.get(tagKey)?.pollIntervalMs;
      if (existingInterval && existingInterval < newInterval) {
        console.log(`[Poller] Coalescing pollers for '${feedConfig.name}' with existing feed with same tag key '${tagKey}'.`)
      } else {
        this.tagConfigs.set(tagKey, { pollIntervalMs: newInterval, batchSize: feedConfig?.batchSize ?? 3 });
        console.log(`[Poller] Set polling interval for tag key '${tagKey}' to ${newInterval}ms.`);
      }
    }
  }
  
  private async initializeDatabase() {
    try {
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database,
      });
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

  startPolling() {
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
    const tagConfig = this.tagConfigs.get(tagKey)
    
    if (!tagConfig) {
      throw new Error(`Failed to find tag config for tag key ${tagKey}.`)
    }

    const lastId = await this.getLastIdForTag(tagKey)
    console.log(`[Poller] Fetching new images for tag '${tagKey}' since ID ${lastId}...`);

    const apiTags = [...tagKey.split(','), 'order:id', `id:>${lastId}`].join(' ')

    try {
      const response = await axios.get<RawDanbooruPost[]>(`https://testbooru.donmai.us/posts.json`, {
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

    const result = await this.db.get<{ last_image_id: number }>(
      'SELECT last_image_id FROM last_ids WHERE tag_key = ?',
      [tagKey]
    );
    // Returns the stored ID, or 0 if the tag is new
    return result?.last_image_id ?? 0;
  }

  private async saveLastIdForTag(tagKey: string, id: number): Promise<void> {
    if (!this.db) return;

    // Uses a transaction to ensure atomicity
    await this.db.run(
      `INSERT INTO last_ids (tag_key, last_image_id) 
        VALUES (?, ?) 
        ON CONFLICT(tag) DO UPDATE SET last_image_id = excluded.last_image_id`,
      [tagKey, id]
    );
  }

  private parseDanbooruPost(post: RawDanbooruPost): DanbooruImage {
    const expectedFields = ['id', 'rating', 'tag_string_artist', 'tag_string_character', 'tag_string_general', 'tag_string_copyright', 'file_ext', 'file_size'] as (keyof UncheckedBasePostApiResult)[]
    checkFieldsAreDefined(post, expectedFields)
    return {
      id: post.id,
      rating: post.rating,
      source: post?.source ?? null,
      artists: post.tag_string_artist.split(' ').filter((x: string) => x !== ''),
      characters: post.tag_string_character.split(' ').filter((x: string) => x !== ''),
      tags: post.tag_string_general.split(' ').filter((x: string) => x !== ''),
      origin: post.tag_string_copyright.split(' ').filter((x: string) => x !== ''),
      createdAt: post?.created_at ?? (new Date()).toISOString(),
      height: post?.image_height ?? 'Unknown',
      width: post?.image_width ?? 'Unknown',
      fileUrl: post?.file_url ?? null,
      previewUrl: post?.preview_file_url ?? null,
      fileExt: post.file_ext,
      fileSize: post.file_size,
      isBanned: post.is_banned ?? false,
      isDeleted: post.is_deleted ?? false,
      isPending: post.is_pending ?? false,
      isFlagged: post.is_flagged ?? false,
      get readableArtists() { return makeReadableList(cleanUpTags(this.artists)) },
      get readableCharacters() { return makeReadableList(cleanUpTags(this.characters)) },
      get readableOrigin() { return makeReadableList(cleanUpTags(this.origin)) },
      get readableFileSize() { return formatBytes(this.fileSize) },
      get postUrl() { return `${baseEndpoint}/posts/${this.id}` },
      get artistUrl() { return `${baseEndpoint}/posts?tags=${this.artists.join('+')}` },
      get dimensions() { return `${this.width} × ${this.height}` }
    }
	}
}

class DiscordFeed {
  private eventBus: EventBus;
  private config: FeedConfig;
  private tagKey: string;
  private name: string;

  constructor(eventBus: EventBus, config: FeedConfig) {
    this.eventBus = eventBus;
    this.config = config;
    this.name = config.name;
    this.tagKey = getTagKey(config.tags)
    this.subscribe();
  }

  private subscribe() {
    this.eventBus.onNewImage(this.tagKey, this.handleNewImage.bind(this));
  }

  private async handleNewImage(image: DanbooruImage) {
    console.log(`[Feed:${this.config.name}] Received new image for tag '${this.tagKey}', ID: ${image.id}`);
    const payload = this.createDiscordWebhookPayload(image);

    console.log(payload)

    for (const destination of this.config.webhookDestinations) {
      try {
        console.log(`[Feed:${this.config.name}] Sending webhook to ${destination.name || destination.url}...`);
        await axios.post(destination.url, payload);
        console.log(`[Feed:${this.config.name}] Webhook sent successfully for image ID ${image.id} to ${destination.name || destination.url}`);
      } catch (error: any) {
        console.error(`[Feed:${this.config.name} Error] Failed to send webhook to ${destination.name || destination.url} for image ID ${image.id}:`, error.message);
        console.error(error)
        if (error.response) {
          console.error('Response data:', error.response.data);
          console.error('Response status:', error.response.status);
        }
        // Implement retry logic here if needed
      }
    }
  }

  private createDiscordWebhookPayload(image: DanbooruImage): DiscordWebhook {
    let color = 0xCCCCCC; // Grey default
    if (image.rating === 's') color = 0x00FF00; // Green for safe
    if (image.rating === 'q') color = 0xFFA500; // Orange for questionable
    if (image.rating === 'e') color = 0xFF0000; // Red for explicit

    const embedTitle = `${truncateString(image.readableCharacters)} from ${truncateString(image.readableOrigin)}`
		const embedFile = (() => {
			if (['jpg', 'png', 'webp', 'gif', 'sfw'].includes(image.fileExt)) {
        if (image.fileUrl === null) return null
				return { image: { url: image.fileUrl }}
			}
			if (['mp4', 'webm'].includes(image.fileExt)) {
        if (image.previewUrl === null) return null
				return { image: { url: image.previewUrl }}
			}
			if (['zip'].includes(image.fileExt)) {
				console.warn(`Ugoira file type not supported`)
				return null
			}
			console.warn({ provider: name, ext: image.fileExt }, `Unknown file type`)
			return null
		})()
		const embedArtist = image.artists.length > 0 ? { description: `By **[${image.readableArtists}](${image.artistUrl})**` } : null
		return {
			embeds: [{
				title: embedTitle,
				url: image.postUrl,
				...embedArtist,
				...embedFile,
				footer: { text: `${image.dimensions} • ${image.readableFileSize}` },
				timestamp: image.createdAt,
        color,
			}],
		}
  }
}

async function main() {
  const DANBOORU_API_KEY = process.env.DANBOORU_API_KEY || '';
  const DANBOORU_API_USER = process.env.DANBOORU_API_USER || '';

  if (DANBOORU_API_KEY === '' || DANBOORU_API_USER === '') {
    console.warn('WARNING: Danbooru API Key or User not set. Polling might be severely rate-limited or fail. Please set DANBOORU_API_KEY and DANBOORU_API_USER environment variables.');
  }

  const eventBus = new EventBus();

  const feedConfigs: FeedConfig[] = [
    {
      name: 'test-feed',
      tags: ['blue_archive'],
      webhookDestinations: [{ name: 'test', url: 'https://discord.com/api/webhooks/1398160813029851147/7Kz_XExS-QZTCVJ2He5Qf5Uk_sjwpvGPFlb0t8fsy8SIin2cyygjQHk5V3G2r0LrVUqd' }],
    },
  ];

  // Initialize the Poller
  const poller = new DanbooruPoller(
    eventBus,
    DANBOORU_API_KEY,
    DANBOORU_API_USER,
    feedConfigs,
  );

  const discordFeeds = feedConfigs.map(config => new DiscordFeed(eventBus, config));
  poller.startPolling();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[App] SIGINT received, stopping polling...');
    poller.stopPolling();
    console.log('[App] Application shutting down.');
    process.exit(0);
  });
}

main().catch(err => {
    console.error('Unhandled application error:', err);
    process.exit(1);
});