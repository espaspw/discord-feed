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

    for (const destination of this.config.webhookDestinations) {
      let attempts = 0;
      const maxAttempts = 5;
      while (attempts < 5) {
        attempts += 1;
        try {
          console.log(`[Feed:${this.config.name}] Sending webhook to ${destination.name || destination.url} for image ID ${image.id}`);
          await axios.post(destination.url, payload);
          console.log(`[Feed:${this.config.name}] Webhook sent successfully for image ID ${image.id} to ${destination.name || destination.url}`);
          break;
        } catch (error: any) {
          if (error.response && error.response.status === 429) {
            // If rate-limited, delay for the time given in the retry_after response, plus a random delay of up to one second * num attempts (linear backoff).
            const retryAfterSeconds = error.response.data.retry_after + Math.random() * attempts;
            console.warn(
              `[Feed:${this.config.name} Warn] Rate limit detected for image ID ${image.id} towards ${destination.name}. Retrying after ${retryAfterSeconds.toFixed(2)}s.`
            );
            await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000));
            continue;
          } else {
            console.error(`[Feed:${this.config.name} Error] Failed to send webhook for image ID ${image.id} to ${destination.name || destination.url}:`, error.message);
            if (error.response) {
              console.error('Response data:', error.response.data);
              console.error('Response status:', error.response.status);
            }
            break;
          }
        }
      }
      if (attempts >= maxAttempts) {
        console.error(`[Feed:${this.config.name} Error] Failed to send webhook for image ID ${image.id} to ${destination.name || destination.url} after ${maxAttempts} attempts.`);
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
