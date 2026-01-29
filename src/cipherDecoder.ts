// cipherDecoder.ts
// Strict YouTube cipher decoder (A1 style)
// Fetches player JS, extracts the n-transform function, and applies it.

import fetch from "node-fetch";

let cachedTransform: ((n: string) => string) | null = null;
let cachedPlayerUrl: string | null = null;

/**
 * Fetch the current YouTube player JS URL.
 */
async function getPlayerUrl(): Promise<string> {
  if (cachedPlayerUrl) return cachedPlayerUrl;

  const res = await fetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ"); // any video
  const html = await res.text();

  const match = html.match(/"jsUrl":"([^"]+)"/);
  if (!match) throw new Error("Could not find player jsUrl");

  const jsUrl = "https://youtube.com" + match[1];
  cachedPlayerUrl = jsUrl;
  return jsUrl;
}

/**
 * Fetch and parse the player JS to extract the cipher transform.
 */
async function getTransform(): Promise<(n: string) => string> {
  if (cachedTransform) return cachedTransform;

  const jsUrl = await getPlayerUrl();
  const res = await fetch(jsUrl);
  const jsCode = await res.text();

  // Find the function name that transforms n
  const fnNameMatch = jsCode.match(/\.get\("n"\)\)&&\(b=(\w+)\([a-z]\)/);
  if (!fnNameMatch) throw new Error("Could not locate n-transform function name");

  const fnName = fnNameMatch[1];

  // Extract the function body
  const fnBodyMatch = jsCode.match(
    new RegExp(`${fnName}=function\\(a\\){(.*?)}`, "s")
  );
  if (!fnBodyMatch) throw new Error("Could not extract n-transform function body");

  const fnBody = fnBodyMatch[1];

  // Extract helper object name
  const helperMatch = fnBody.match(/([A-Za-z0-9$]{2})\\.[A-Za-z0-9]{2}\\(a,\\d+\\)/);
  if (!helperMatch) throw new Error("Could not find helper object name");

  const helperName = helperMatch[1];

  // Extract helper object definition
  const helperMatch2 = jsCode.match(
    new RegExp(`var ${helperName}={(.*?)};`, "s")
  );
  if (!helperMatch2) throw new Error("Could not extract helper object");

  const helperBody = helperMatch2[1];

  // Build operations map
  const operations: Record<string, (a: string[], b: number) => void> = {};

  helperBody.split("},").forEach((entry) => {
    const [name, body] = entry.split(":function");
    if (!name || !body) return;
    const opName = name.trim();
    if (body.includes("reverse")) {
      operations[opName] = (a) => a.reverse();
    } else if (body.includes("splice")) {
      operations[opName] = (a, b) => a.splice(0, b);
    } else if (body.includes("var c=a[0];a[0]=a[b%a.length];a[b]=c")) {
      operations[opName] = (a, b) => {
        const c = a[0];
        a[0] = a[b % a.length];
        a[b] = c;
      };
    }
    // Add more cases if needed
  });

  // Build transform function
  const transform = (n: string): string => {
    let arr = n.split("");
    const steps = fnBody.match(/([A-Za-z0-9$]{2})\\.[A-Za-z0-9]{2}\\(a,\\d+\\)/g) || [];
    steps.forEach((step) => {
      const opMatch = step.match(/([A-Za-z0-9$]{2})\\.([A-Za-z0-9]{2})\\(a,(\\d+)\\)/);
      if (!opMatch) return;
      const [, obj, method, numStr] = opMatch;
      const num = parseInt(numStr, 10);
      const op = operations[method];
      if (op) op(arr, num);
    });
    return arr.join("");
  };

  cachedTransform = transform;
  return transform;
}

/**
 * Decode a ciphered n= parameter.
 */
export async function decodeN(n: string): Promise<string> {
  const transform = await getTransform();
  return transform(n);
}

/**
 * Fix a YouTube URL by decoding its n= parameter if present.
 */
export async function fixUrl(url: string): Promise<string> {
  const u = new URL(url);
  const n = u.searchParams.get("n");
  if (n) {
    const decoded = await decodeN(n);
    u.searchParams.set("n", decoded);
  }
  if (!u.searchParams.has("ratebypass")) {
    u.searchParams.set("ratebypass", "yes");
  }
  return u.toString();
}
