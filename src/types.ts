export interface WebhookDestination {
  name: string;
  url: string;
}

export interface FeedConfig {
  name: string;
  tags: string[];
  webhookNames: string[];
  pollingIntervalMs: number;
  batchSize: number;
}

export interface ResolvedFeedConfig {
  name: string;
  tags: string[];
  webhookDestinations: WebhookDestination[];
  pollingIntervalMs: number;
  batchSize: number;
}

export interface TagConfig {
  pollIntervalMs: number;
  batchSize: number;
}

export interface RawDanbooruPost {
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

export interface DanbooruImage {
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
  readableArtists: string;
  readableCharacters: string;
  readableOrigin: string;
  readableFileSize: string;
  postUrl: string;
  artistUrl: string;
  dimensions: string;
}
