// Public "download the app" endpoints. The APK itself is stored in Supabase Storage;
// the app_releases table says which file is current. Nothing here needs a login.
const express = require("express");
const QRCode = require("qrcode");
const { eq, and, desc, sql } = require("drizzle-orm");
const { db, schema } = require("../db");

const router = express.Router();

function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

// Only plain https links are ever followed, whatever is in the table.
function isSafeFileUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Supabase public-storage links accept ?download=<name>, which makes browsers save the
// file instead of trying to open it. Other hosts' links are left exactly as they are.
function withDownloadName(fileUrl, name) {
  const url = new URL(fileUrl);
  if (url.pathname.includes("/storage/v1/object/public/") && !url.searchParams.has("download")) {
    url.searchParams.set("download", name);
  }
  return url.toString();
}

// If the file size wasn't typed into the table, ask the file host for it (cached, so
// the page never waits on it more than occasionally, and never fails because of it).
const sizeCache = new Map();
async function lookupSize(fileUrl) {
  const hit = sizeCache.get(fileUrl);
  if (hit && hit.expires > Date.now()) return hit.size;

  let size = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(fileUrl, { method: "HEAD", signal: controller.signal });
    const n = Number(res.headers.get("content-length"));
    if (res.ok && Number.isFinite(n) && n > 0) size = n;
  } catch {
    // leave size unknown
  } finally {
    clearTimeout(timer);
  }
  sizeCache.set(fileUrl, { size, expires: Date.now() + (size ? 10 * 60 * 1000 : 60 * 1000) });
  return size;
}

async function latestAndroidRelease() {
  const [release] = await db
    .select()
    .from(schema.appReleases)
    .where(and(sql`lower(btrim(${schema.appReleases.platform})) = 'android'`, eq(schema.appReleases.isActive, true)))
    .orderBy(desc(schema.appReleases.createdAt))
    .limit(1);
  return release || null;
}

// What the download page shows: the newest active Android release, if any.
router.get("/android/latest", async (req, res) => {
  const release = await latestAndroidRelease();
  res.set("Cache-Control", "public, max-age=60");
  if (!release || !isSafeFileUrl(release.fileUrl)) return res.json({ available: false });

  res.json({
    available: true,
    release: {
      id: release.id,
      version: release.version,
      releaseNotes: release.releaseNotes,
      sizeBytes: release.sizeBytes ?? (await lookupSize(release.fileUrl)),
      createdAt: release.createdAt,
      downloadUrl: `/api/downloads/${release.id}/file`,
    },
  });
});

// The download button points here: count the download, then send the browser to the file.
router.get("/:id/file", async (req, res) => {
  const [release] = await db
    .select()
    .from(schema.appReleases)
    .where(and(eq(schema.appReleases.id, req.params.id), eq(schema.appReleases.isActive, true)))
    .limit(1);
  if (!release || !isSafeFileUrl(release.fileUrl)) return res.status(404).json({ error: "That download isn't available." });

  if (req.method === "GET") {
    try {
      await db.update(schema.appReleases).set({ downloadCount: sql`${schema.appReleases.downloadCount} + 1` }).where(eq(schema.appReleases.id, release.id));
    } catch (e) {
      console.error("[downloads] Couldn't count a download:", e.message); // never block the download over a counter
    }
  }

  const safeVersion = String(release.version).replace(/[^A-Za-z0-9._-]+/g, "-");
  res.redirect(302, withDownloadName(release.fileUrl, `Orivon-${safeVersion}.apk`));
});

// QR code that opens the download page (scan it from a phone while on a computer).
router.get("/qr.svg", async (req, res) => {
  const svg = await QRCode.toString(`${appUrl(req)}/#/download`, {
    type: "svg",
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#1F2420", light: "#FFFFFF" }, // always dark-on-white so it scans in dark mode too
  });
  res.set("Content-Type", "image/svg+xml");
  res.set("Cache-Control", "public, max-age=3600");
  res.send(svg);
});

module.exports = router;
