// TypeScript interfaces for Invidious API responses

export interface InvidiousPluginOptions {
  instance: string; // Invidious instance URL (e.g., "yewtu.be", "https://yewtu.be", "http://localhost:8095")
  timeout?: number; // optional timeout (default: 10000 ms)
}

export interface InvidiousVideoResponse {
  videoId: string;
  title: string;
  videoThumbnails: Array<{
    quality: string;
    url: string;
    width: number;
    height: number;
  }>;
  lengthSeconds: number;
  author: string;
  authorId: string;
  authorUrl: string;
  viewCount: number;
  likeCount: number;
  liveNow: boolean;
  recommendedVideos: InvidiousVideoResponse[];
  formatStreams: Array<{
    url: string;
    type: string;
    mimeType?: string;
    quality: string;
  }>;
  adaptiveFormats: Array<{
    url: string;
    type: string;
    mimeType?: string;
    encoding?: string;
    bitrate?: string;
    contentLength?: string;
    itag?: string;
    clen?: string;
  }>;
  hlsUrl?: string;
  dashUrl?: string;
}

export interface InvidiousPlaylistResponse {
  title: string;
  playlistId: string;
  author: string;
  authorId: string;
  videoCount: number;
  videos: Array<{
    title: string;
    videoId: string;
    author: string;
    lengthSeconds: number;
    videoThumbnails: Array<{ url: string; width: number; height: number }>;
  }>;
}

export interface InvidiousSearchResponse {
  type: string;
  title: string;
  videoId?: string;
  author: string;
  videoThumbnails: Array<{ url: string; width: number; height: number }>;
  lengthSeconds?: number;
}

export interface InvidiousChannelResponse {
  author: string;
  authorId: string;
  latestVideos: InvidiousVideoResponse[];
}
