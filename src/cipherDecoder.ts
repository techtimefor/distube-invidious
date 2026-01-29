// cipherDecoder.ts
// Strict YouTube cipher decoder (dynamic, yt-dlp-style-ish)
// Fetches player JS, extracts the n-transform function, and applies it.

import fetch from "node-fetch";

let cachedTransform: ((n: string) => string) | null = null;
let cachedPlayerUrl: string | null = null;
let cachedPlayerCode: string | null = null;

/**
 * Fetch a YouTube watch page and extract the player JS URL.
 */
async function getPlayerUrl(): Promise<string> {
  if (cachedPlayerUrl) return cachedPlayerUrl;

  const res = await fetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  if (!res.ok) {
    throw new Error(`Failed to fetch watch page: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();

  // Try multiple patterns, YouTube changes this often.
  const patterns = [
    /"jsUrl":"([^"]+)"/, // modern
    /"PLAYER_JS_URL":"([^"]+)"/,
    /"js":"([^"]+base\.js)"/,
    /"assets":\{"js":"([^"]+)"\}/,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const url = m[1].startsWith("http")
        ? m[1]
        : "https://www.youtube.com" + m[1];
      cachedPlayerUrl = url;
      return url;
    }
  }

  throw new Error("Could not find player JS URL in watch page");
}

/**
 * Fetch the player JS code.
 */
async function getPlayerCode(): Promise<string> {
  if (cachedPlayerCode) return cachedPlayerCode;

  const jsUrl = await getPlayerUrl();
  const res = await fetch(jsUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch player JS: ${res.status} ${res.statusText}`);
  }
  const code = await res.text();
  cachedPlayerCode = code;
  return code;
}

/**
 * Extract the name of the n-transform function from player JS.
 */
function extractNFunctionName(jsCode: string): string {
  const candidates: RegExp[] = [
    // Older pattern
    /\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]+)\([a-z]\)/,
    // Newer patterns
    /(?:\bncode|\bncode_)\s*=\s*([a-zA-Z0-9$]+)\([a-zA-Z0-9$]+\)/,
    /["']n["']\s*,\s*([a-zA-Z0-9$]+)\(/,
    /(?:\w+)=\w\.get\("n"\)\)&&\(\w=([a-zA-Z0-9$]+)\(\w\)\)/,
  ];

  for (const re of candidates) {
    const m = jsCode.match(re);
    if (m && m[1]) return m[1];
  }

  throw new Error("Could not locate n-transform function name");
}

/**
 * Extract the body of a named function from player JS.
 */
function extractFunctionBody(jsCode: string, fnName: string): string {
  // Try function declaration: fnName=function(a){...}
  let re = new RegExp(`${fnName}=function\\(\\w\\){([^}]+)}`, "s");
  let m = jsCode.match(re);
  if (m && m[1]) return m[1];

  // Try function declaration with more complex body
  re = new RegExp(`${fnName}=function\\(\\w\\){([^}]+?)};`, "s");
  m = jsCode.match(re);
  if (m && m[1]) return m[1];

  // Try arrow function: fnName=(a)=>{...}
  re = new RegExp(`${fnName}=\\(\\w\\)=>{([^}]+)}`, "s");
  m = jsCode.match(re);
  if (m && m[1]) return m[1];

  throw new Error("Could not extract n-transform function body");
}

/**
 * Extract helper object name used inside the n-transform function.
 */
function extractHelperName(fnBody: string): string {
  const m =
    fnBody.match(/([A-Za-z0-9$]{2})\.[A-Za-z0-9$]{2}\(\w, ?\d+\)/) ||
    fnBody.match(/([A-Za-z0-9$]{2})\.[A-Za-z0-9$]{2}\(\w, ?[A-Za-z0-9$]+\)/);
  if (!m || !m[1]) {
    throw new Error("Could not find helper object name");
  }
  return m[1];
}

/**
 * Extract helper object definition from player JS.
 */
function extractHelperObject(jsCode: string, helperName: string): string {
  const patterns = [
    new RegExp(`var ${helperName}={(.*?)};`, "s"),
    new RegExp(`let ${helperName}={(.*?)};`, "s"),
    new RegExp(`const ${helperName}={(.*?)};`, "s"),
  ];

  for (const re of patterns) {
    const m = jsCode.match(re);
    if (m && m[1]) return m[1];
  }

  throw new Error("Could not extract helper object");
}

/**
 * Build operations map from helper object body.
 */
function buildOperations(helperBody: string): Record<string, (a: string[], b: number) => void> {
  const operations: Record<string, (a: string[], b: number) => void> = {};

  // Split object entries: name:function(a,b){...}
  const entries = helperBody.split("},");
  for (const entry of entries) {
    const [rawName, rawBody] = entry.split(":function");
    if (!rawName || !rawBody) continue;
    const name = rawName.trim();
    const body = rawBody;

    if (body.includes("reverse")) {
      operations[name] = (a) => a.reverse();
    } else if (body.includes("splice")) {
      operations[name] = (a, b) => {
        a.splice(0, b);
      };
    } else if (body.includes("var c=a[0];a[0]=a[b%a.length];a[b]=c")) {
      operations[name] = (a, b) => {
        const idx = b % a.length;
        const c = a[0];
        a[0] = a[idx];
        a[idx] = c;
      };
    } else if (body.includes("a.push(a.splice(0,b)[0])")) {
      operations[name] = (a, b) => {
        while (b-- > 0) {
          a.push(a.splice(0, 1)[0]);
        }
      };
    }
    // You can extend this with more patterns if YouTube adds new ops.
  }

  return operations;
}

/**
 * Build the transform function from the function body and operations map.
 */
function buildTransform(fnBody: string, operations: Record<string, (a: string[], b: number) => void>): (n: string) => string {
  // Find all calls like: helper.op(a, 3)
  const calls =
    fnBody.match(/([A-Za-z0-9$]{2})\.([A-Za-z0-9$]{2})\(\w, ?(\d+)\)/g) || [];

  const steps: { method: string; arg: number }[] = [];

  for (const call of calls) {
    const m = call.match(
      /([A-Za-z0-9$]{2})\.([A-Za-z0-9$]{2})\(\w, ?(\d+)\)/,
    );
    if (!m) continue;
    const method = m[2];
    const arg = parseInt(m[3], 10);
    steps.push({ method, arg });
  }

  return (n: string): string => {
    const arr = n.split("");
    for (const step of steps) {
      const op = operations[step.method];
      if (op) {
        op(arr, step.arg);
      }
    }
    return arr.join("");
  };
}

/**
 * Get (or build) the n-transform function.
 */
async function getTransform(): Promise<(n: string) => string> {
  if (cachedTransform) return cachedTransform;

  const jsCode = await getPlayerCode();

  const fnName = extractNFunctionName(jsCode);
  const fnBody = extractFunctionBody(jsCode, fnName);
  const helperName = extractHelperName(fnBody);
  const helperBody = extractHelperObject(jsCode, helperName);
  const operations = buildOperations(helperBody);
  const transform = buildTransform(fnBody, operations);

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
 * Fix a YouTube URL by decoding its n= parameter if present and ensuring ratebypass.
 */
export async function fixUrl(url: string): Promise<string> {
  const u = new URL(url);
  const n = u.searchParams.get("n");
  if (n) {
    try {
      const decoded = await decodeN(n);
      u.searchParams.set("n", decoded);
    } catch (e) {
      console.warn(
        "[cipherDecoder] Failed to decode n= cipher:",
        (e as Error).message,
      );
    }
  }
  if (!u.searchParams.has("ratebypass")) {
    u.searchParams.set("ratebypass", "yes");
  }
  return u.toString();
}