import {
  DisTube,
  ExtractorPlugin,
  Playlist,
  ResolveOptions,
  Song,
  DisTubeError,
} from "distube";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import * as path from "path";
import { tmpdir } from "os";
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
  private readonly tempDir: string;

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

    // Create temp directory for audio downloads
    this.tempDir = path.join(tmpdir(), "distube-invidious");
    this.ensureTempDir();
  }

  /**
   * Ensure the temp directory exists
   */
  private async ensureTempDir(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch {
      // Directory might already exist
    }
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
   * This method downloads audio to a temporary file to avoid FFmpeg issues with direct streaming URLs.
   * It prioritizes opus by quality (highest bitrate first), then AAC.
   *
   * Quality priority:
   * 1. Opus audio (highest bitrate → lowest bitrate)
   * 2. AAC audio (highest bitrate → lowest bitrate)
   * 3. Any other audio format
   */

  async getStreamURL(song: Song): Promise<string> {
    const apiUrl = `${this.instance}/api/v1/videos/${song.id}`;
    const data = (await this.WithTimeout(apiUrl)) as InvidiousVideoResponse;

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

    // Helper: Extract bitrate from format (for quality sorting)
    const getBitrate = (format: {
      bitrate?: string;
      contentLength?: string;
      clen?: string;
    }): number => {
      if (format.bitrate) {
        return parseInt(format.bitrate, 10);
      }
      if (format.contentLength) {
        return parseInt(format.contentLength, 10);
      }
      if (format.clen) {
        return parseInt(format.clen, 10);
      }
      return 0;
    };

    console.log(`[InvidiousPlugin] Processing ${song.id}...`);

    // Collect all opus formats
    const opusFormats: Array<{
      url: string;
      bitrate: number;
      itag?: string;
    }> = [];

    // Collect all AAC formats
    const aacFormats: Array<{
      url: string;
      bitrate: number;
      itag?: string;
    }> = [];

    // Collect other audio formats
    const otherFormats: Array<{
      url: string;
      type: string;
      bitrate: number;
    }> = [];

    // Extract from adaptiveFormats
    if (data.adaptiveFormats && data.adaptiveFormats.length > 0) {
      for (const format of data.adaptiveFormats) {
        if (!isAudioFormat(format) || !format.url) {
          continue;
        }

        const mimeType = (format.mimeType || format.type || "").toLowerCase();
        const bitrate = getBitrate(format);

        if (mimeType.includes("opus")) {
          opusFormats.push({
            url: format.url,
            bitrate,
            itag: (format as any).itag,
          });
        } else if (mimeType.includes("aac") || mimeType.includes("mp4a")) {
          aacFormats.push({
            url: format.url,
            bitrate,
            itag: (format as any).itag,
          });
        } else {
          otherFormats.push({
            url: format.url,
            type: format.mimeType || format.type || "unknown",
            bitrate,
          });
        }
      }
    }

    // Sort formats by bitrate (highest first)
    opusFormats.sort((a, b) => b.bitrate - a.bitrate);
    aacFormats.sort((a, b) => b.bitrate - a.bitrate);
    otherFormats.sort((a, b) => b.bitrate - a.bitrate);

    console.log(
      `[InvidiousPlugin] Found ${opusFormats.length} opus, ${aacFormats.length} AAC, ${otherFormats.length} other audio formats`
    );

    // Priority 1: Try to download opus (highest bitrate first)
    if (opusFormats.length > 0) {
      const bestOpus = opusFormats[0];
      console.log(`[InvidiousPlugin] Downloading opus audio (bitrate: ${bestOpus.bitrate}, itag: ${bestOpus.itag})...`);
      try {
        return await this.downloadAudio(bestOpus.url, song.id);
      } catch (error) {
        console.log(`[InvidiousPlugin] Opus download failed: ${(error as Error).message}`);
      }
    }

    // Priority 2: Try to download AAC (highest bitrate first)
    if (aacFormats.length > 0) {
      const bestAac = aacFormats[0];
      console.log(`[InvidiousPlugin] Downloading AAC audio (bitrate: ${bestAac.bitrate}, itag: ${bestAac.itag})...`);
      try {
        return await this.downloadAudio(bestAac.url, song.id);
      } catch (error) {
        console.log(`[InvidiousPlugin] AAC download failed: ${(error as Error).message}`);
      }
    }

    // Priority 3: Try to download other audio formats (highest bitrate first)
    if (otherFormats.length > 0) {
      const bestOther = otherFormats[0];
      console.log(`[InvidiousPlugin] Downloading ${bestOther.type} audio (bitrate: ${bestOther.bitrate})...`);
      try {
        return await this.downloadAudio(bestOther.url, song.id);
      } catch (error) {
        console.log(`[InvidiousPlugin] ${bestOther.type} download failed: ${(error as Error).message}`);
      }
    }

    // Everything failed - throw error
    console.error(`[InvidiousPlugin] ERROR: All download attempts failed for ${song.id}`);
    console.error(`[InvidiousPlugin] Opus formats: ${opusFormats.length}`);
    console.error(`[InvidiousPlugin] AAC formats: ${aacFormats.length}`);
    console.error(`[InvidiousPlugin] Other formats: ${otherFormats.length}`);
    console.error(`[InvidiousPlugin] Try: different Invidious instance or check if video is available`);

    throw new DisTubeError(
      "CANNOT_GET_STREAM_URL",
      "All download methods failed. Try a different Invidious instance or check if the video is available."
    );
  }

  /**
   * Gets related songs for a given song.
   */

  async getRelatedSongs(song: Song): Promise<Song[]> {
    const apiUrl = `${this.instance}/api/v1/videos/${song.id}`;
    const data = (await this.WithTimeout(apiUrl)) as InvidiousVideoResponse;

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
   * Downloads audio from a URL to a temporary file.
   * Returns the local file path.
   */
  private async downloadAudio(url: string, videoId: string): Promise<string> {
    await this.ensureTempDir();

    const filename = `${videoId}.webm`;
    const filePath = path.join(this.tempDir, filename);

    console.log(`[InvidiousPlugin] Downloading audio to temp file: ${filePath}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

    
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          Origin: "https://www.youtube.com",
          Referer: "https://www.youtube.com/",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "cross-site",
          "Sec-Ch-Ua":
            '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new DisTubeError(
          "CANNOT_GET_STREAM_URL",
          `Download failed: HTTP ${response.status}`
        );
      }

      const buffer = await response.arrayBuffer();

      await fs.writeFile(filePath, new Uint8Array(buffer));

      console.log(`[InvidiousPlugin] ✓ Download complete: ${filePath}`);
      return filePath;
    } catch (error) {
      throw new DisTubeError(
        "CANNOT_GET_STREAM_URL",
        `Failed to download audio: ${(error as Error).message}`
      );
    }
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
