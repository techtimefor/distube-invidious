import {
  ExtractorPlugin,
  Playlist,
  ResolveOptions,
  Song,
  DisTubeError,
} from "distube";
import fetch from "node-fetch";
import type {
  InvidiousPluginOptions,
  InvidiousVideoResponse,
  InvidiousPlaylistResponse,
  InvidiousSearchResponse,
} from "./types.js";
import {
  stripQuery,
  isYouTubeUrl,
  extractVideoId,
  extractPlaylistId,
} from "./url-utils.js";


// InvidiousPlugin Class

export class InvidiousPlugin extends ExtractorPlugin {
  readonly instance: string;
  private readonly timeout: number;

  constructor(options: InvidiousPluginOptions) {
    super();
    // Normalize instance:
    // 1. Remove trailing slash
    // 2. Prepend "https://" if missing
    let normalized = options.instance.replace(/\/+$/, "");
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
      normalized = "https://" + normalized;
    }
    this.instance = normalized;
    this.timeout = options.timeout ?? 10000;
  }

  // Required ExtractorPlugin Methods

  /**
   * Validates if URL is a YouTube URL.
   * Calls stripQuery() first to remove tracking parameters.
   */

  validate(url: string): boolean {
    return isYouTubeUrl(url);
  }

  /**
   * Resolves a URL to a Song or Playlist.
   * Calls stripQuery() first to remove tracking parameters.
   */

  async resolve<T>(
    url: string,
    options: ResolveOptions<T>,
  ): Promise<Song<T> | Playlist<T>> {
    const cleanUrl = stripQuery(url);

    // Check if it's a playlist URL
    if (cleanUrl.includes("list=") && !cleanUrl.includes("v=")) {
      return this.playlist<T>(url, options);
    }

    // Extract video ID
    const videoId = extractVideoId(cleanUrl);
    if (!videoId) {
      throw new DisTubeError("CANNOT_RESOLVE_SONG", "Invalid YouTube URL");
    }

    // Fetch video data from Invidious API
    const apiUrl = `${this.instance}/api/v1/videos/${videoId}`;
    const data = (await this.fetchWithTimeout(apiUrl)) as InvidiousVideoResponse;

    // Convert to Song
    return this.createSong<T>(data, options);
  }

  /**
   * Searches for a song and returns the first result.
   */

  async searchSong<T>(
    query: string,
    options: ResolveOptions<T>,
  ): Promise<Song<T> | null> {
    const apiUrl = `${this.instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
    const data = (await this.fetchWithTimeout(apiUrl)) as InvidiousSearchResponse[];

    if (!data || data.length === 0) {
      return null;
    }

    const firstResult = data[0];
    if (!firstResult.videoId) {
      return null;
    }

    // Fetch full video data
    const videoUrl = `${this.instance}/api/v1/videos/${firstResult.videoId}`;
    const videoData = (await this.fetchWithTimeout(
      videoUrl,
    )) as InvidiousVideoResponse;

    return this.createSong<T>(videoData, options);
  }

  /**
   * Gets the stream URL for a song.
   * Fetches fresh video data and extracts highest-quality audio stream.
   *
   * Priority:
   * 1. audio/webm with opus codec (best quality)
   * 2. audio/mp4 with mp4a.40.2 codec (AAC)
   * 3. Any other audio-only format
   *
   * Throws CANNOT_GET_STREAM_URL if no valid audio stream is found.
   */
  async getStreamURL(song: Song): Promise<string> {
    const apiUrl = `${this.instance}/api/v1/videos/${song.id}`;
    const data = (await this.fetchWithTimeout(apiUrl)) as InvidiousVideoResponse;

    let selectedFormat: {
      url: string;
      mimeType?: string;
      type?: string;
      encoding?: string;
    } | null = null;
    let selectionReason = "";

    // Helper function to check if a format is audio-only
    const isAudioOnly = (format: { mimeType?: string; type?: string }): boolean => {
      const mimeType = (format.mimeType || format.type || "").toLowerCase();
      // Must start with "audio/" to be audio-only
      return mimeType.startsWith("audio/");
    };

    // Helper function to check codec
    const hasCodec = (
      format: { mimeType?: string; type?: string; encoding?: string },
      codec: string
    ): boolean => {
      const mimeType = (format.mimeType || format.type || "").toLowerCase();
      const encoding = (format.encoding || "").toLowerCase();
      return mimeType.includes(codec) || encoding.includes(codec);
    };

    // Priority 1: Look for audio/webm with opus codec (best quality for FFmpeg)
    if (data.adaptiveFormats && data.adaptiveFormats.length > 0) {
      const found = data.adaptiveFormats.find((format) => {
        if (!isAudioOnly(format) || !format.url) return false;
        const mimeType = (format.mimeType || format.type || "").toLowerCase();
        // Check for audio/webm with opus
        return mimeType.startsWith("audio/webm") && hasCodec(format, "opus");
      });

      if (found) {
        selectedFormat = found;
        selectionReason = "audio/webm + opus";
      }
    }

    // Priority 2: Look for audio/mp4 with AAC codec (mp4a.40.2)
    if (!selectedFormat && data.adaptiveFormats && data.adaptiveFormats.length > 0) {
      const found = data.adaptiveFormats.find((format) => {
        if (!isAudioOnly(format) || !format.url) return false;
        const mimeType = (format.mimeType || format.type || "").toLowerCase();
        // Check for audio/mp4 with AAC codec
        return (
          mimeType.startsWith("audio/mp4") &&
          (hasCodec(format, "mp4a.40.2") || hasCodec(format, "aac"))
        );
      });

      if (found) {
        selectedFormat = found;
        selectionReason = "audio/mp4 + aac";
      }
    }

    // Priority 3: Look for any audio-only format with a direct URL
    if (!selectedFormat && data.adaptiveFormats && data.adaptiveFormats.length > 0) {
      const found = data.adaptiveFormats.find((format) => {
        if (!isAudioOnly(format) || !format.url) return false;
        // Make sure it's not a manifest/dash file
        const url = format.url.toLowerCase();
        return (
          !url.includes("/dash/") && !url.endsWith(".mpd") && !url.endsWith(".m3u8")
        );
      });

      if (found) {
        selectedFormat = found;
        selectionReason = "any audio-only format";
      }
    }

    // If we found a format, validate and return it
    if (selectedFormat && selectedFormat.url) {
      // Validate the URL is not empty
      if (selectedFormat.url.trim() === "") {
        throw new DisTubeError("CANNOT_GET_STREAM_URL", "Selected audio URL is empty");
      }

      // Log the selected format for debugging
      console.log(`[InvidiousPlugin] Selected audio stream for ${song.id}:`);
      console.log(`  Format: ${selectedFormat.mimeType || selectedFormat.type || "unknown"}`);
      console.log(`  Encoding: ${selectedFormat.encoding || "unknown"}`);
      console.log(`  Reason: ${selectionReason}`);
      console.log(`  URL length: ${selectedFormat.url.length} chars`);

      return selectedFormat.url;
    }

    // If we get here, no valid audio stream was found
    console.error(`[InvidiousPlugin] No valid audio stream found for ${song.id}`);
    if (data.adaptiveFormats) {
      console.error(`[InvidiousPlugin] Available formats:`);
      data.adaptiveFormats.forEach((format, index) => {
        console.error(`  [${index}] ${format.mimeType || format.type || "unknown"} - encoding: ${format.encoding || "unknown"} - has url: ${!!format.url}`);
      });
    }

    throw new DisTubeError(
      "CANNOT_GET_STREAM_URL",
      "No playable audio stream found. The video may not be available on this Invidious instance."
    );
  }

  /**
   * Gets related songs for a given song.
   */

  async getRelatedSongs(song: Song): Promise<Song[]> {
    const apiUrl = `${this.instance}/api/v1/videos/${song.id}`;
    const data = (await this.fetchWithTimeout(apiUrl)) as InvidiousVideoResponse;

    if (!data.recommendedVideos || data.recommendedVideos.length === 0) {
      return [];
    }

    // Return up to 10 related songs
    return data.recommendedVideos.slice(0, 10).map((video) =>
      this.createSongFromData(video),
    );
  }

  // Playlist Resolution
  
  /**
   * Public method for direct playlist resolution.
   */

  async playlist<T>(
    url: string,
    options: ResolveOptions<T>,
  ): Promise<Playlist<T>> {
    const cleanUrl = stripQuery(url);
    const playlistId = extractPlaylistId(cleanUrl);

    if (!playlistId) {
      throw new DisTubeError("CANNOT_RESOLVE_SONG", "Invalid playlist URL");
    }

    const apiUrl = `${this.instance}/api/v1/playlists/${playlistId}`;
    const data = (await this.fetchWithTimeout(apiUrl)) as InvidiousPlaylistResponse;

    // Create Song objects from playlist videos
    const songs = data.videos.map((video) =>
      this.createSongFromData({
        videoId: video.videoId,
        title: video.title,
        author: video.author,
        authorId: data.authorId,
        authorUrl: `/channel/${data.authorId}`,
        lengthSeconds: video.lengthSeconds,
        videoThumbnails: video.videoThumbnails.map((t) => ({
          quality: "",
          url: t.url,
          width: t.width,
          height: t.height,
        })),
        viewCount: 0,
        likeCount: 0,
        liveNow: false,
        recommendedVideos: [],
        formatStreams: [],
        adaptiveFormats: [],
      } as InvidiousVideoResponse),
    );

    // Create Playlist object
    const playlist = new Playlist(
      {
        source: "youtube",
        name: data.title,
        id: data.playlistId,
        url: `${this.instance}/playlist?list=${data.playlistId}`,
        thumbnail: this.getBestThumbnail(data.videos[0]?.videoThumbnails || []),
        songs,
      },
      options,
    );

    return playlist as Playlist<T>;
  }

  
  // Private Helper Methods

  /**
   * Wraps fetch with AbortController for timeout handling.
   */

  private async fetchWithTimeout(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new DisTubeError(
          "CANNOT_RESOLVE_SONG",
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      return await response.json();
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new DisTubeError("CANNOT_RESOLVE_SONG", "Request timeout");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Returns highest-resolution thumbnail URL.
   */

  private getBestThumbnail(
    thumbnails: Array<{ url: string; width: number; height: number }>,
  ): string {
    if (!thumbnails || thumbnails.length === 0) {
      return "";
    }

    // Sort by resolution (width * height) and return the highest
    const sorted = [...thumbnails].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    );
    return sorted[0].url;
  }

  /**
   * Creates a Song object from Invidious video data.
   */

  private createSong<T>(
    data: InvidiousVideoResponse,
    options: ResolveOptions<T>,
  ): Song<T> {
    const song = new Song(
      {
        plugin: this,
        source: "youtube",
        playFromSource: true,
        id: data.videoId,
        name: data.title,
        url: `${this.instance}/watch?v=${data.videoId}`,
        thumbnail: this.getBestThumbnail(data.videoThumbnails),
        duration: data.lengthSeconds,
        isLive: data.liveNow,
        views: data.viewCount,
        likes: data.likeCount,
        uploader: {
          name: data.author,
          url: `${this.instance}${data.authorUrl}`,
        },
      },
      options,
    );

    return song;
  }

  /**
   * Creates a Song object from video data (for related videos).
   */

  private createSongFromData(data: InvidiousVideoResponse): Song {
    const song = new Song({
      plugin: this,
      source: "youtube",
      playFromSource: true,
      id: data.videoId,
      name: data.title,
      url: `${this.instance}/watch?v=${data.videoId}`,
      thumbnail: this.getBestThumbnail(data.videoThumbnails),
      duration: data.lengthSeconds,
      isLive: data.liveNow,
      views: data.viewCount,
      likes: data.likeCount,
      uploader: {
        name: data.author,
        url: `${this.instance}/channel/${data.authorId}`,
      },
    });

    return song;
  }
}

export default InvidiousPlugin;
