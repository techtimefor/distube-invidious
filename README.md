# DisTube Invidious Plugin

A [DisTube](https://github.com/skick1234/DisTube) extractor plugin that routes all YouTube URLs through an [Invidious](https://invidious.io/) instance for privacy-friendly music playback.

This is an ExtractorPlugin, find out more about it [here](https://github.com/skick1234/DisTube/wiki/Projects-Hub#extractorplugin).

## Features

- 🎵 Play YouTube videos through any Invidious instance
- 🔒 Privacy-friendly - no direct YouTube API calls
- 📝 Playlist support
- 🔍 Search functionality
- 🎼 Related songs recommendations
- ⚙️ Configurable timeout
- 🌐 Supports all YouTube URL formats (watch, shorts, live, embed, youtu.be, playlists)

## Installation

```bash
npm install distube-invidious
```

## Usage

```typescript
import { DisTube } from "distube";
import { InvidiousPlugin } from "distube-invidious";

const distube = new DisTube({
  plugins: [
    new InvidiousPlugin({
      instance: "yewtu.be", // or any other Invidious instance
    }),
  ],
  // Required for Google Video URLs to work:
  ffmpeg: InvidiousPlugin.getRecommendedFFmpegConfig()
});
```

### Basic Example

```typescript
import { DisTube } from "distube";
import { InvidiousPlugin } from "distube-invidious";

// Initialize DisTube with Invidious plugin
const distube = new DisTube({
  plugins: [
    new InvidiousPlugin({
      instance: "yewtu.be",
      timeout: 10000, // Optional: request timeout in milliseconds (default: 10000)
    }),
  ],
});

// Play a YouTube video
distube.play(voiceChannel, "https://youtube.com/watch?v=dQw4w9WgXcQ");

// Play a playlist
distube.play(voiceChannel, "https://youtube.com/playlist?list=PLxyz123");

// Search for a song
distube.play(voiceChannel, "never gonna give you up");
```

## Configuration Options

### `InvidiousPluginOptions`

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `instance` | `string` | Yes | - | Invidious instance URL (e.g., "yewtu.be", "https://yewtu.be", "http://localhost:8095") |
| `timeout` | `number` | No | `10000` | Request timeout in milliseconds |

### Public Invidious Instances

You can find a list of public Invidious instances at:
- https://docs.invidious.io/instances/


## Supported YouTube URLs

The plugin supports all YouTube URL formats:

- **Videos**: `youtube.com/watch?v=ID`
- **Short URLs**: `youtu.be/ID`
- **Shorts**: `youtube.com/shorts/ID`
- **Live**: `youtube.com/live/ID`
- **Embed**: `youtube.com/embed/ID`
- **Playlists**: `youtube.com/playlist?list=ID`
- **Channels**: `youtube.com/channel/UCxxxx`, `youtube.com/@handle`, `youtube.com/c/CustomName`, `youtube.com/user/username`

It also handles shared YouTube links with tracking parameters:
- `https://youtu.be/ID?si=xxx` ✅

## Advanced Usage

### Direct Playlist Resolution

```typescript
import { InvidiousPlugin } from "distube-invidious";

const plugin = new InvidiousPlugin({ instance: "yewtu.be" });

// Resolve a playlist directly
const playlist = await plugin.playlist(
  "https://youtube.com/playlist?list=PLxyz123",
  {}
);

console.log(`Playlist: ${playlist.name}`);
console.log(`Songs: ${playlist.songs.length}`);
```

### Stream URL Extraction

```typescript
// Get the audio stream URL for a song
const streamUrl = await plugin.getStreamURL(song);
console.log(`Stream URL: ${streamUrl}`);
```

### Related Songs

```typescript
// Get related songs for a video
const relatedSongs = await plugin.getRelatedSongs(song);
console.log(`Found ${relatedSongs.length} related songs`);
```

## API

### `InvidiousPlugin`

#### Methods

- **`validate(url: string): boolean`** - Checks if a URL is a valid YouTube URL
- **`resolve(url, options): Promise<Song \| Playlist>`** - Resolves a URL to a Song or Playlist
- **`searchSong(query, options): Promise<Song \| null>`** - Searches for a song
- **`getStreamURL(song): Promise<string>`** - Gets the audio stream URL
- **`getRelatedSongs(song): Promise<Song[]>`** - Gets related songs
- **`playlist(url, options): Promise<Playlist>`** - Resolves a playlist directly

## Requirements

- Node.js 16+
- DisTube 4.0.0 or 5.0.0+

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Disclaimer

This plugin is not affiliated with, endorsed by, or connected to YouTube, DisTube or Invidious. Also this plugin is an unofficial plugin to help enhance your DisTube experience!
