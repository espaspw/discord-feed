import { EventEmitter } from 'events';
import type { DanbooruImage } from './types';

export class EventBus extends EventEmitter {
  emitNewImage(tagKey: string, image: DanbooruImage) {
    this.emit(`newImage:${tagKey}`, image);
    console.log(`[EventBus] Emitted new image for tag key: ${tagKey}, ID: ${image.id}`);
  }

  onNewImage(tagKey: string, listener: (image: DanbooruImage) => void) {
    this.on(`newImage:${tagKey}`, listener);
    console.log(`[EventBus] Subscribed to new images for tag key: ${tagKey}`);
  }
}
