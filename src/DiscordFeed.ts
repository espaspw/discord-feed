import axios from 'axios';
import type { RESTPostAPIWebhookWithTokenJSONBody as DiscordWebhook } from 'discord.js';

import { EventBus } from './EventBus';
import type { FeedConfig, DanbooruImage } from './types';
import { getTagKey, truncateString } from './util';

export class DiscordFeed {
  private eventBus: EventBus;
  private config: FeedConfig;
  private tagKey: string;
  private name: string;

  constructor(eventBus: EventBus, config: FeedConfig) {
    this.eventBus = eventBus;
    this.config = config;
    this.name = config.name;
    this.tagKey = getTagKey(config.tags);
    this.subscribe();
  }

  private subscribe() {
    this.eventBus.onNewImage(this.tagKey, this.handleNewImage.bind(this));
  }

  private async handleNewImage(image: DanbooruImage) {
    console.log(`[Feed:${this.config.name}] Received new image for tag '${this.tagKey}', ID: ${image.id}`);
    const payload = this.createDiscordWebhookPayload(image);

    console.log(payload);

    for (const destination of this.config.webhookDestinations) {
      try {
        console.log(`[Feed:${this.config.name}] Sending webhook to ${destination.name || destination.url}...`);
        await axios.post(destination.url, payload);
        console.log(`[Feed:${this.config.name}] Webhook sent successfully for image ID ${image.id} to ${destination.name || destination.url}`);
      } catch (error: any) {
        console.error(`[Feed:${this.config.name} Error] Failed to send webhook to ${destination.name || destination.url} for image ID ${image.id}:`, error.message);
        console.error(error);
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

    const embedTitle = `${truncateString(image.readableCharacters)} from ${truncateString(image.readableOrigin)}`;
    const embedFile = (() => {
      if (['jpg', 'png', 'webp', 'gif', 'sfw'].includes(image.fileExt)) {
        if (image.fileUrl === null) return null;
        return { image: { url: image.fileUrl } };
      }
      if (['mp4', 'webm'].includes(image.fileExt)) {
        if (image.previewUrl === null) return null;
        return { image: { url: image.previewUrl } };
      }
      if (['zip'].includes(image.fileExt)) {
        console.warn(`Ugoira file type not supported`);
        return null;
      }
      console.warn({ provider: name, ext: image.fileExt }, `Unknown file type`);
      return null;
    })();
    const embedArtist = image.artists.length > 0 ? { description: `By **[${image.readableArtists}](${image.artistUrl})**` } : null;
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
    };
  }
}
