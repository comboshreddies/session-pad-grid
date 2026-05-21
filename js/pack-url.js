/**
 * @module pack-url
 * Remote pack.json URL validation and base URL for resolving loop WAV paths.
 */

const SOUNDLIB_PACK_PATH_RE = /\/soundlib\/([^/]+)\/pack\.json$/i;

/**
 * Normalize a file URL pathname (file:////Users/... → /Users/...).
 * @param {string} pathname
 * @returns {string}
 */
function normalizeFilePathname(pathname) {
  let p = String(pathname || "");
  if (p.startsWith("//") && !p.startsWith("///")) {
    p = p.replace(/^\/+/, "/");
  }
  return p;
}

/**
 * @param {string} input
 * @returns {string|null} absolute filesystem path, or null
 */
function absolutePathFromPackInput(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (/^file:\/\//i.test(s)) {
    try {
      return normalizeFilePathname(new URL(s).pathname);
    } catch {
      return null;
    }
  }
  if (s.startsWith("/")) return s.replace(/\\/g, "/");
  if (/^[A-Za-z]:[\\/]/.test(s)) return s.replace(/\\/g, "/");
  return null;
}

/**
 * When the app is served over http(s), map a local file path under soundlib/ to same-origin pack.json.
 * @param {string} pathname
 * @param {string} pageHref
 * @returns {string|null}
 */
function httpPackUrlFromSoundlibPath(pathname, pageHref) {
  const m = pathname.match(SOUNDLIB_PACK_PATH_RE);
  if (!m || !pageHref || !/^https?:/i.test(pageHref)) return null;
  try {
    return new URL(`soundlib/${m[1]}/pack.json`, new URL(pageHref)).href;
  } catch {
    return null;
  }
}

/**
 * Resolve user input to a URL the browser can fetch.
 * Accepts http(s), file://, and absolute paths. Local paths under …/soundlib/&lt;slug&gt;/pack.json
 * are rewritten to same-origin http when the page is not file://.
 *
 * @param {string} input
 * @param {string} [pageHref] defaults to `location.href` in the browser
 * @returns {string}
 */
export function resolvePackJsonUrl(input, pageHref = typeof location !== "undefined" ? location.href : "") {
  const s = String(input || "").trim();
  if (!s) throw new Error("Enter a pack.json URL or path.");

  if (/^ftp:\/\//i.test(s)) {
    throw new Error(
      "Browsers cannot load ftp:// URLs. Host pack.json and WAVs on http:// or https://, or copy the pack into soundlib/.",
    );
  }

  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).href;
    } catch {
      throw new Error("Invalid pack.json URL.");
    }
  }

  const pathname = absolutePathFromPackInput(s);
  if (pathname) {
    const httpUrl = httpPackUrlFromSoundlibPath(pathname, pageHref);
    if (httpUrl) return httpUrl;

    const slugMatch = pathname.match(SOUNDLIB_PACK_PATH_RE);
    const slugHint = slugMatch?.[1] ?? null;
    let pageOrigin = "http://127.0.0.1/";
    try {
      if (pageHref && /^https?:/i.test(pageHref)) pageOrigin = new URL(pageHref).origin + "/";
    } catch {
      /* ignore */
    }
    const localHint = slugHint
      ? `Use Asset source “Local soundlib” and sample set “${slugHint}”, or: ${pageOrigin}soundlib/${slugHint}/pack.json`
      : "Copy the pack under soundlib/ and use Local soundlib, or serve it over http:// or https://.";
    throw new Error(
      `Browsers cannot fetch pack.json from a file path when this page is opened over http(s). ${localHint}`,
    );
  }

  throw new Error("Pack URL must start with http://, https://, file://, or an absolute path.");
}

/**
 * @param {string} input
 * @param {string} [pageHref]
 * @returns {string} normalized fetchable URL
 */
export function normalizePackJsonUrl(input, pageHref) {
  return resolvePackJsonUrl(input, pageHref);
}

/**
 * Directory containing pack.json — used as base for relative `loop.url` paths.
 * @param {string} packJsonUrl
 * @returns {string} trailing slash
 */
export function directoryBaseFromPackJsonUrl(packJsonUrl) {
  const base = new URL("./", packJsonUrl).href;
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * @param {string} packJsonUrl
 * @returns {string}
 */
export function slugHintFromPackJsonUrl(packJsonUrl) {
  try {
    const parts = new URL(packJsonUrl).pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[parts.length - 1].toLowerCase() === "pack.json") {
      return parts[parts.length - 2];
    }
    const last = parts[parts.length - 1] ?? "";
    return last.replace(/\.json$/i, "") || "remote";
  } catch {
    return "remote";
  }
}
