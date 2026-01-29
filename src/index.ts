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
   *
   * IMPORTANT NOTES:
   * - Invidious URLs may have n= cipher that requires decoding (not implemented here as it
   *   requires parsing YouTube's player JavaScript which changes frequently)
   * - This method validates URLs using GET requests with Range headers since HEAD fails
   * - ratebypass=yes is ensured to be present for better compatibility
   *
   * Priority:
   * 1. formatStreams (most reliable, pre-signed URLs)
   * 2. adaptiveFormats opus (validated)
   * 3. adaptiveFormats AAC (validated)
   * 4. adaptiveFormats any audio (validated)
   */

  async getStreamURL(song: Song): Promise<string> {
    const apiUrl = `${this.instance}/api/v1/videos/${song.id}`;
    const data = (await this.fetchWithTimeout(apiUrl)) as InvidiousVideoResponse;

    // Helper: Check if URL is a manifest (not direct audio data)
    const isManifestUrl = (url: string): boolean => {
      const lowerUrl = url.toLowerCase();
      return (
        lowerUrl.includes("/dash/") ||
        lowerUrl.endsWith(".mpd") ||
        lowerUrl.endsWith(".m3u8")
      );
    };

    // Helper: Ensure ratebypass=yes is present (required for many YouTube streams)
    const ensureRatebypass = (url: string): string => {
      if (!url.toLowerCase().includes("ratebypass=")) {
        const separator = url.includes("?") ? "&" : "?";
        return `${url}${separator}ratebypass=yes`;
      }
      return url;
    };

    // Helper: Check if format is audio-only
    const isAudioFormat = (
      format: { mimeType?: string; type?: string },
      codec?: string
    ): boolean => {
      const mimeType = (format.mimeType || format.type || "").toLowerCase();
      const isAudio = mimeType.startsWith("audio/");
      if (codec && isAudio) {
        return mimeType.includes(codec);
      }
      return isAudio;
    };

    // Helper: Validate URL using GET with Range header (more reliable than HEAD)
    const validateUrl = async (url: string): Promise<boolean> => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        // Use GET with Range header instead of HEAD (Google servers respond to this)
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Range: "bytes=0-1", // Only request first byte
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        // Accept 206 (Partial Content) or 200 (OK)
        return response.status === 206 || response.status === 200;
      } catch (error) {
        console.log(`[InvidiousPlugin] Validation failed: ${(error as Error).message}`);
        return false;
      }
    };

    // Helper: Try to validate and return a URL, with fallback
    const tryUrl = async (
      url: string,
      formatName: string
    ): Promise<string | null> => {
      if (!url || isManifestUrl(url)) {
        return null;
      }

      // Ensure ratebypass=yes is present
      url = ensureRatebypass(url);

      console.log(`[InvidiousPlugin] Trying ${formatName}`);
      console.log(`[InvidiousPlugin] URL: ${url.substring(0, 100)}...`);
      console.log(`[InvidiousPlugin] Validating with GET + Range: bytes=0-1...`);

      if (await validateUrl(url)) {
        console.log(`[InvidiousPlugin] ✓ Validation passed!`);
        return url;
      } else {
        console.log(`[InvidiousPlugin] ✗ Validation failed, trying next format`);
        return null;
      }
    };

    // Priority 1: Try formatStreams (pre-signed URLs, most reliable)

    console.log(`[InvidiousPlugin] Checking formatStreams for ${song.id}...`);

    if (data.formatStreams && data.formatStreams.length > 0) {
      for (const format of data.formatStreams) {
        // Try audio/webm + opus
        if (
          isAudioFormat(format, "webm") &&
          (format.type?.toLowerCase().includes("opus") ||
            format.mimeType?.toLowerCase().includes("opus"))
        ) {
          if (format.url) {
            const result = await tryUrl(format.url, "formatStreams audio/webm + opus");
            if (result) return result;
          }
        }

        // Try audio/mp4 + AAC
        if (
          isAudioFormat(format, "mp4") &&
          (format.type?.toLowerCase().includes("mp4a") ||
            format.type?.toLowerCase().includes("aac") ||
            format.mimeType?.toLowerCase().includes("mp4a") ||
            format.mimeType?.toLowerCase().includes("aac"))
        ) {
          if (format.url) {
            const result = await tryUrl(format.url, "formatStreams audio/mp4 + AAC");
            if (result) return result;
          }
        }
      }

      // Fallback: Try any audio format in formatStreams
      for (const format of data.formatStreams) {
        if (isAudioFormat(format) && format.url) {
          const result = await tryUrl(
            format.url,
            `formatStreams ${format.type || format.mimeType}`
          );
          if (result) return result;
        }
      }
    }

    // Priority 2: Try adaptiveFormats (may require cipher decoding)

    console.log(`[InvidiousPlugin] No valid formatStreams found, checking adaptiveFormats...`);

    if (data.adaptiveFormats && data.adaptiveFormats.length > 0) {
      // Try audio/webm + opus
      for (const format of data.adaptiveFormats) {
        if (
          isAudioFormat(format, "webm") &&
          (format.encoding?.toLowerCase().includes("opus") ||
            format.mimeType?.toLowerCase().includes("opus") ||
            format.type?.toLowerCase().includes("opus"))
        ) {
          if (format.url) {
            const result = await tryUrl(format.url, "adaptiveFormats audio/webm + opus");
            if (result) return result;
          }
        }
      }

      // Try audio/mp4 + AAC (more compatible)
      for (const format of data.adaptiveFormats) {
        if (
          isAudioFormat(format, "mp4") &&
          (format.encoding?.toLowerCase().includes("aac") ||
            format.mimeType?.toLowerCase().includes("aac") ||
            format.mimeType?.toLowerCase().includes("mp4a.40.2") ||
            format.type?.toLowerCase().includes("aac") ||
            format.type?.toLowerCase().includes("mp4a.40.2"))
        ) {
          if (format.url) {
            const result = await tryUrl(format.url, "adaptiveFormats audio/mp4 + AAC");
            if (result) return result;
          }
        }
      }

      // Fallback: Try any audio format in adaptiveFormats
      for (const format of data.adaptiveFormats) {
        if (isAudioFormat(format) && format.url) {
          const result = await tryUrl(
            format.url,
            `adaptiveFormats ${format.type || format.mimeType}`
          );
          if (result) return result;
        }
      }
    }

    // No valid stream found - throw error

    console.error(`[InvidiousPlugin] ERROR: No valid audio stream found for ${song.id}`);
    console.error(`[InvidiousPlugin] FormatStreams count: ${data.formatStreams?.length || 0}`);
    console.error(`[InvidiousPlugin] AdaptiveFormats count: ${data.adaptiveFormats?.length || 0}`);
    console.error(`[InvidiousPlugin] NOTE: If URLs contain n= parameter, they may need cipher decoding`);
    console.error(`[InvidiousPlugin] NOTE: Try a different Invidious instance or check if the video is region-restricted`);

    throw new DisTubeError(
      "CANNOT_GET_STREAM_URL",
      "No playable audio stream found. All URLs failed validation. The video may require n= cipher decoding (not implemented), or the Invidious instance may be having issues."
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
