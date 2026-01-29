// URL Parser Helper Functions for YouTube/Invidious URLs

/**
 * Strips query parameters from URL (everything from "?" onward).
 * Must be called FIRST in all URL parsing functions to handle shared
 * YouTube links with tracking parameters (e.g., https://youtu.be/ID?si=xxx).
 */
export function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.substring(0, q);
}

/**
 * Tests if URL matches any YouTube URL pattern.
 */
export function isYouTubeUrl(url: string): boolean {
  const cleanUrl = stripQuery(url);
  const patterns = [
    /^https?:\/\/(www\.)?youtube\.com\/watch\?v=/,
    /^https?:\/\/youtu\.be\//,
    /^https?:\/\/(www\.)?youtube\.com\/shorts\//,
    /^https?:\/\/(www\.)?youtube\.com\/live\//,
    /^https?:\/\/(www\.)?youtube\.com\/embed\//,
    /^https?:\/\/(www\.)?youtube\.com\/playlist/,
    /^https?:\/\/(www\.)?youtube\.com\/channel\//,
    /^https?:\/\/(www\.)?youtube\.com\/c\//,
    /^https?:\/\/(www\.)?youtube\.com\/user\//,
    /^https?:\/\/(www\.)?youtube\.com\/@/,
  ];
  return patterns.some((pattern) => pattern.test(cleanUrl));
}

/**
 * Extracts video ID from URL patterns.
 */
export function extractVideoId(url: string): string | null {
  const cleanUrl = stripQuery(url);

  // Standard watch URL: ?v=ID
  const watchMatch = cleanUrl.match(/[?&]v=([^&]+)/);
  if (watchMatch) return watchMatch[1];

  // Short URL: youtu.be/ID
  const shortMatch = cleanUrl.match(/youtu\.be\/([^/?]+)/);
  if (shortMatch) return shortMatch[1];

  // Shorts: /shorts/ID
  const shortsMatch = cleanUrl.match(/youtube\.com\/shorts\/([^/?]+)/);
  if (shortsMatch) return shortsMatch[1];

  // Live: /live/ID
  const liveMatch = cleanUrl.match(/youtube\.com\/live\/([^/?]+)/);
  if (liveMatch) return liveMatch[1];

  // Embed: /embed/ID
  const embedMatch = cleanUrl.match(/youtube\.com\/embed\/([^/?]+)/);
  if (embedMatch) return embedMatch[1];

  return null;
}

/**
 * Extracts playlist ID using pattern: [?&]list=
 */
export function extractPlaylistId(url: string): string | null {
  const cleanUrl = stripQuery(url);
  const match = cleanUrl.match(/[?&]list=([^&]+)/);
  return match ? match[1] : null;
}

/**
 * Extracts channel identifier from patterns.
 */
export function extractChannel(url: string): string | null {
  const cleanUrl = stripQuery(url);

  // /channel/UCxxxx
  const channelMatch = cleanUrl.match(/\/channel\/([^/?]+)/);
  if (channelMatch) return channelMatch[1];

  // /c/CustomName
  const customMatch = cleanUrl.match(/\/c\/([^/?]+)/);
  if (customMatch) return customMatch[1];

  // /user/username
  const userMatch = cleanUrl.match(/\/user\/([^/?]+)/);
  if (userMatch) return userMatch[1];

  // /@handle
  const handleMatch = cleanUrl.match(/\/@([^/?]+)/);
  if (handleMatch) return handleMatch[1];

  return null;
}

/**
 * Converts any YouTube URL to Invidious equivalent using normalized instance URL.
 */
export function toInvidious(url: string, instance: string): string {
  const cleanUrl = stripQuery(url);
  const patterns = [
    {
      regex: /^https?:\/\/(www\.)?youtube\.com\/watch\?v=([^&]+)/,
      replace: `${instance}/watch?v=$2`,
    },
    {
      regex: /^https?:\/\/youtu\.be\/([^/?]+)/,
      replace: `${instance}/watch?v=$1`,
    },
    {
      regex: /^https?:\/\/(www\.)?youtube\.com\/shorts\/([^/?]+)/,
      replace: `${instance}/watch?v=$2`,
    },
    {
      regex: /^https?:\/\/(www\.)?youtube\.com\/live\/([^/?]+)/,
      replace: `${instance}/watch?v=$2`,
    },
    {
      regex: /^https?:\/\/(www\.)?youtube\.com\/embed\/([^/?]+)/,
      replace: `${instance}/watch?v=$2`,
    },
    {
      regex: /^https?:\/\/(www\.)?youtube\.com\/playlist\?list=([^&]+)/,
      replace: `${instance}/playlist?list=$2`,
    },
    {
      regex: /^https?:\/\/(www\.)?youtube\.com\/channel\/([^/?]+)/,
      replace: `${instance}/channel/$2`,
    },
    {
      regex: /^https?:\/\/(www\.)?youtube\.com\/c\/([^/?]+)/,
      replace: `${instance}/channel/$2`,
    },
    {
      regex: /^https?:\/\/(www\.)?youtube\.com\/user\/([^/?]+)/,
      replace: `${instance}/user/$2`,
    },
    {
      regex: /^https?:\/\/(www\.)?youtube\.com\/@([^/?]+)/,
      replace: `${instance}/@$2`,
    },
  ];

  for (const pattern of patterns) {
    const match = cleanUrl.match(pattern.regex);
    if (match) {
      return pattern.replace;
    }
  }

  return url;
}
