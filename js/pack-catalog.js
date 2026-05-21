/**
 * @module pack-catalog
 * Remote pack lists via a manifest JSON (browsers cannot list directory URLs).
 */

import { normalizeHttpUrl, resolvePackJsonUrl } from "./pack-url.js";

/**
 * @typedef {{ slug: string, title: string, packJsonUrl: string }} PackCatalogEntry
 */

/**
 * @param {unknown} json
 * @returns {boolean}
 */
export function isPackCatalogDocument(json) {
  if (!json || typeof json !== "object") return false;
  if ("session" in json && "loops" in json) return false;
  const arr = /** @type {{ packs?: unknown }} */ (json).packs;
  if (Array.isArray(arr) && arr.length > 0) return true;
  return Array.isArray(json) && json.length > 0;
}

/**
 * @param {unknown} json
 * @param {string} catalogUrl resolved manifest URL
 * @param {string} [pageHref]
 * @returns {PackCatalogEntry[]}
 */
export function parsePackCatalog(json, catalogUrl, pageHref = typeof location !== "undefined" ? location.href : "") {
  const base = normalizeHttpUrl(new URL("./", catalogUrl).href);
  const rawList = Array.isArray(json)
    ? json
    : Array.isArray(/** @type {{ packs?: unknown[] }} */ (json).packs)
      ? /** @type {{ packs: unknown[] }} */ (json).packs
      : [];
  const entries = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const rec = /** @type {Record<string, unknown>} */ (item);
    const slug = String(rec.slug ?? rec.id ?? "").trim();
    if (!slug) continue;
    const title = String(rec.title ?? rec.name ?? slug).trim() || slug;
    let packRef = String(rec.pack ?? rec.packJson ?? rec.url ?? "").trim();
    if (!packRef) packRef = `${slug}/pack.json`;
    let packJsonUrl;
    if (/^https?:\/\//i.test(packRef)) {
      packJsonUrl = resolvePackJsonUrl(packRef, pageHref);
    } else if (packRef.startsWith("/")) {
      packJsonUrl = normalizeHttpUrl(new URL(packRef, pageHref || base).href);
    } else {
      const rel = packRef.replace(/^\//, "");
      packJsonUrl = normalizeHttpUrl(
        new URL(
          rel.split("/").map((seg) => encodeURIComponent(seg)).join("/"),
          base,
        ).href,
      );
    }
    entries.push({ slug, title, packJsonUrl });
  }
  if (!entries.length) {
    throw new Error("Catalog has no packs. Use { \"packs\": [ { \"slug\", \"title\", \"pack\" } ] }.");
  }
  return entries;
}

/**
 * @param {string} catalogUrl
 * @param {string} [pageHref]
 * @returns {Promise<{ catalogUrl: string, entries: PackCatalogEntry[] }>}
 */
export async function fetchPackCatalog(catalogUrl, pageHref = typeof location !== "undefined" ? location.href : "") {
  const url = resolvePackJsonUrl(catalogUrl, pageHref);
  const res = await fetch(url, { cache: "no-store", mode: "cors" });
  if (!res.ok) throw new Error(`catalog ${res.status}: ${url}`);
  const json = await res.json();
  if (!isPackCatalogDocument(json)) {
    throw new Error("Not a pack catalog — expected { \"packs\": [ … ] } without session/loops.");
  }
  return { catalogUrl: url, entries: parsePackCatalog(json, url, pageHref) };
}
