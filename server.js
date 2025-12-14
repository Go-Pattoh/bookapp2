// server.js
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcrypt");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const morgan = require("morgan");

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"))
// Sessions (server-side). For production use a persistent store (Redis, MySQL store, etc.).
app.use(
  session({
    name: process.env.SESSION_NAME || "shelfcloud_sid",
    secret: process.env.SESSION_SECRET || "change-this-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    },
  })
);
app.use(express.static(__dirname)); // serve static files (index_mod.html etc.)

// Create mysql pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "shelfcloud",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// If DB_SSL is set (e.g. REQUIRED) add ssl options to the pool (mysql2 supports ssl option)
if (process.env.DB_SSL) {
  // Node mysql2 accepts an `ssl` option; set a simple rejectUnauthorized flag when SSL is required.
  // For production with self-signed certs you may need to provide CA certs here.
  pool.config.connectionConfig.ssl = {
    rejectUnauthorized:
      process.env.DB_SSL === "REQUIRED" || process.env.DB_SSL === "true",
  };
}

// Ensure DB schema exists on startup unless SKIP_DB_INIT is set
async function ensureDatabaseInitialized() {
  if (process.env.SKIP_DB_INIT === "true") return;
  try {
    const sqlPath = path.join(__dirname, "db.js");
    const sql = fs.readFileSync(sqlPath, "utf8");
    // Create a temporary connection without a database selection so CREATE DATABASE works
    const connOptions = {
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASS || "",
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
      multipleStatements: true,
    };
    if (process.env.DB_SSL) {
      connOptions.ssl = {
        rejectUnauthorized:
          process.env.DB_SSL === "REQUIRED" || process.env.DB_SSL === "true",
      };
    }
    console.log(connOptions)

    const conn = await mysql.createConnection(connOptions);
    console.log("Running DB initialization SQL from db.js...");
    await conn.query(sql);
    await conn.end();
    console.log("Database initialization complete.");
  } catch (err) {
    // Log and continue - the server may still be able to operate if DB exists
    console.warn(
      "Database initialization skipped or failed:",
      err && err.message ? err.message : err
    );
  }
}

// Register
app.post("/api/register", async (req, res) => {
  const {
    username: rawUser,
    email: rawEmail,
    password: rawPassword,
  } = req.body || {};
  const username = String(rawUser || "")
    .trim()
    .slice(0, 100);
  const email = String(rawEmail || "")
    .trim()
    .slice(0, 200);
  const password = String(rawPassword || "");

  if (!username || !email || !password) {
    return res.status(400).json({ message: "Missing fields" });
  }
  if (password.length < 6)
    return res.status(400).json({ message: "Password too short" });
  // basic email sanity check
  if (!email.includes("@") || !email.includes("."))
    return res.status(400).json({ message: "Invalid email" });
  try {
    const [exists] = await pool.query("SELECT id FROM users WHERE email = ?", [
      email,
    ]);
    if (exists.length)
      return res.status(400).json({ message: "Email already registered" });

    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
      [username, email, hashed]
    );
    // create server-side session
    try {
      req.session.userId = result.insertId;
      req.session.username = username;
      req.session.email = email;
    } catch (e) {
      // ignore session set failure; continue
      console.warn("Failed to set session on register", e);
    }
    return res.json({ message: "ok", userId: result.insertId, username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { email: rawEmail, password: rawPassword } = req.body || {};
  const ident = String(rawEmail || "")
    .trim()
    .slice(0, 200);
  const password = String(rawPassword || "");
  if (!ident || !password)
    return res.status(400).json({ message: "Missing fields" });
  try {
    // allow login by email OR username
    const [rows] = await pool.query(
      "SELECT id, username, password_hash, email FROM users WHERE email = ? OR username = ? LIMIT 1",
      [ident, ident]
    );
    if (!rows.length)
      return res
        .status(400)
        .json({ message: "No account found with that email or username" });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ message: "Incorrect password" });
    // create server-side session
    try {
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.email = user.email;
    } catch (e) {
      console.warn("Failed to set session on login", e);
    }
    return res.json({ userId: user.id, username: user.username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
});

// Save download (session-based)
app.post("/api/download", async (req, res) => {
  const userId = req.session && req.session.userId;
  const book = req.body && req.body.book;
  if (!userId || !book || typeof book !== "object")
    return res
      .status(401)
      .json({ message: "Not authenticated or missing book" });
  try {
    const sql = `INSERT INTO downloads (user_id, google_id, title, authors_json, cover, infoLink, publishedDate, accessInfo_json, saved_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
    const authorsJson = JSON.stringify(book.authors || []);
    const accessInfoJson = JSON.stringify(book.accessInfo || {});
    await pool.query(sql, [
      userId,
      book.googleId || null,
      book.title || "",
      authorsJson,
      book.cover || "",
      book.infoLink || "",
      book.publishedDate || "",
      accessInfoJson,
    ]);
    return res.json({ message: "ok" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
});

// Get downloads for current session user
app.get("/api/downloads", async (req, res) => {
  const userId = req.session && req.session.userId;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });
  try {
    const [rows] = await pool.query(
      "SELECT id, google_id, title, authors_json, cover, infoLink, publishedDate, saved_at FROM downloads WHERE user_id = ? ORDER BY saved_at DESC",
      [userId]
    );
    const downloads = rows.map((r) => ({
      id: r.id,
      googleId: r.google_id,
      title: r.title,
      authors: JSON.parse(r.authors_json || "[]"),
      cover: r.cover,
      infoLink: r.infoLink,
      publishedDate: r.publishedDate,
      saved_at: r.saved_at,
    }));
    return res.json({ downloads });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
});

// Simple in-memory cache for search results (TTL + max entries)
const searchCache = new Map(); // key -> { data, expires }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX = 200;

function getCached(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    searchCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  // prune oldest if over capacity
  if (searchCache.size >= CACHE_MAX) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey) searchCache.delete(firstKey);
  }
  searchCache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

// Proxy + cache Google Books search and persist fetched books into DB
app.get("/api/search", async (req, res) => {
  let q = String(req.query.q || "").trim();
  // basic sanitization: remove NULLs and control characters, limit length
  q = q.replace(/\x00/g, "").slice(0, 200);
  if (!q) return res.status(400).json({ message: "Missing query parameter q" });

  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  let per_page = Math.max(1, parseInt(req.query.per_page || "20", 10));
  // Google Books limits maxResults to 40
  if (per_page > 40) per_page = 40;

  const preferFresh = req.query.preferFresh === "1";

  const key = `${q.toLowerCase()}:: p = ${page}:: pp = ${per_page} `;

  // Skip memory cache if preferFresh is set
  if (!preferFresh) {
    const cached = getCached(key);
    if (cached)
      return res.json({
        fromCache: true,
        items: cached.items,
        totalItems: cached.totalItems,
        page,
        per_page,
      });
  }

  // DB cache-first: try to serve results from local DB before calling Google
  // Skip DB cache too if preferFresh is set
  if (!preferFresh) {
    try {
      const offset = (page - 1) * per_page;
      const searchPattern = `%${q}%`;
      // fetch cached rows for this query/page
      const [rows] = await pool.query(
        `SELECT google_id, title, authors_json, cover, infoLink, raw_json, fetched_at
         FROM books
         WHERE title LIKE ? OR authors_json LIKE ?
         ORDER BY fetched_at DESC
         LIMIT ? OFFSET ?`,
        [searchPattern, searchPattern, per_page, offset]
      );

      const [countRows] = await pool.query(
        `SELECT COUNT(*) as count FROM books WHERE title LIKE ? OR authors_json LIKE ?`,
        [searchPattern, searchPattern]
      );
      const totalItemsDb = countRows[0].count || 0;

      if (rows && rows.length) {
        // build items array (prefer raw_json if present)
        const items = rows.map((r) => {
          try {
            if (r.raw_json) return JSON.parse(r.raw_json);
          } catch (e) {}
          let pub = "";
          try {
            if (r.raw_json) {
              const parsed = JSON.parse(r.raw_json);
              pub =
                parsed && parsed.volumeInfo && parsed.volumeInfo.publishedDate
                  ? parsed.volumeInfo.publishedDate
                  : "";
            }
          } catch (e) {}
          return {
            id: r.google_id,
            volumeInfo: {
              title: r.title,
              authors: JSON.parse(r.authors_json || "[]"),
              imageLinks: { thumbnail: r.cover },
              infoLink: r.infoLink,
              publishedDate: pub,
            },
          };
        });

        // freshness check
        const DB_TTL_MS = process.env.DB_CACHE_TTL_MS
          ? parseInt(process.env.DB_CACHE_TTL_MS, 10)
          : 24 * 60 * 60 * 1000; // 24h default
        const newestFetched = rows[0].fetched_at
          ? new Date(rows[0].fetched_at).getTime()
          : 0;
        const age = Date.now() - newestFetched;
        const fresh = newestFetched && age <= DB_TTL_MS;

        // If fresh, return cached results immediately
        if (fresh) {
          return res.json({
            fromCache: true,
            stale: false,
            items,
            totalItems: totalItemsDb,
            page,
            per_page,
          });
        }

        // Stale but present: return cached results and trigger background refresh
        // Background refresh - fire and forget
        (async () => {
          try {
            const startIndex = (page - 1) * per_page;
            const fetchFn =
              typeof fetch !== "undefined"
                ? fetch
                : (await import("node-fetch")).default;
            const gres = await fetchFn(
              `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
                q
              )}&startIndex=${startIndex}&maxResults=${per_page}`
            );
            const data = await gres.json();
            const itemsRemote = data.items || [];
            // upsert into DB
            const upsertSql = `INSERT INTO books(google_id, title, authors_json, infoLink, cover, raw_json, fetched_at)
VALUES(?, ?, ?, ?, ?, ?, NOW())
                       ON DUPLICATE KEY UPDATE
title = VALUES(title),
  authors_json = VALUES(authors_json),
  infoLink = VALUES(infoLink),
  cover = VALUES(cover),
  raw_json = VALUES(raw_json),
  fetched_at = VALUES(fetched_at)`;
            const conn = await pool.getConnection();
            try {
              for (const it of itemsRemote) {
                const googleId = it.id || null;
                const volume = it.volumeInfo || {};
                const title = volume.title || "";
                const authorsJson = JSON.stringify(volume.authors || []);
                const infoLink = volume.infoLink || "";
                const cover =
                  (volume.imageLinks &&
                    (volume.imageLinks.thumbnail ||
                      volume.imageLinks.smallThumbnail)) ||
                  "";
                const raw = JSON.stringify(it);
                if (!googleId) continue;
                await conn.query(upsertSql, [
                  googleId,
                  title,
                  authorsJson,
                  infoLink,
                  cover,
                  raw,
                ]);
              }
            } finally {
              conn.release();
            }
            // also update in-memory search cache for fast responses
            setCached(key, {
              items: itemsRemote,
              totalItems: data.totalItems || itemsRemote.length,
            });
          } catch (e) {
            console.warn(
              "Background refresh failed",
              e && e.message ? e.message : e
            );
          }
        })();

        return res.json({
          fromCache: true,
          stale: true,
          backgroundRefreshTriggered: true,
          items,
          totalItems: totalItemsDb,
          page,
          per_page,
        });
      }
    } catch (err) {
      console.error(
        "DB cache query error",
        err && err.message ? err.message : err
      );
      // fall through to remote fetch logic below
    }
  } // End of if (!preferFresh) for DB cache

  // Rate limit non-logged-in users: allow a small number of Google Books calls per session
  const isLoggedIn = req.session && req.session.userId;
  if (!isLoggedIn) {
    req.session.googleCallsCount = req.session.googleCallsCount || 0;
    const ALLOWED = 3; // limit for anonymous users
    if (req.session.googleCallsCount >= ALLOWED) {
      // Serve from DB (local search) as a fallback when rate limit exceeded
      try {
        const offset = (page - 1) * per_page;
        const searchPattern = `%${q}%`;
        const [rows] = await pool.query(
          `SELECT google_id, title, authors_json, cover, infoLink, raw_json
           FROM books
           WHERE title LIKE ? OR authors_json LIKE ?
           ORDER BY fetched_at DESC
           LIMIT ? OFFSET ?`,
          [searchPattern, searchPattern, per_page, offset]
        );

        const [countRows] = await pool.query(
          `SELECT COUNT(*) as count FROM books WHERE title LIKE ? OR authors_json LIKE ?`,
          [searchPattern, searchPattern]
        );
        const totalItems = countRows[0].count;

        const items = rows.map((r) => {
          try {
            if (r.raw_json) return JSON.parse(r.raw_json);
          } catch (e) {}
          // Try to extract publishedDate from raw_json if available
          let pub = "";
          try {
            if (r.raw_json) {
              const parsed = JSON.parse(r.raw_json);
              pub =
                parsed && parsed.volumeInfo && parsed.volumeInfo.publishedDate
                  ? parsed.volumeInfo.publishedDate
                  : "";
            }
          } catch (e) {}

          return {
            id: r.google_id,
            volumeInfo: {
              title: r.title,
              authors: JSON.parse(r.authors_json || "[]"),
              imageLinks: { thumbnail: r.cover },
              infoLink: r.infoLink,
              publishedDate: pub,
            },
          };
        });

        return res.json({
          rateLimited: true,
          fromCache: true,
          items,
          totalItems,
          page,
          per_page,
          message: `Anonymous rate limit reached (${ALLOWED}). Showing cached results.`,
        });
      } catch (err) {
        console.error("Local fallback after rate limit failed", err);
        // continue to attempt remote fetch as a last resort
      }
    }
  }

  try {
    const startIndex = (page - 1) * per_page;
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
      q
    )}&startIndex=${startIndex}&maxResults=${per_page}`;
    // Increment anonymous user's Google call count when we are about to proxy to Google
    if (!isLoggedIn) {
      req.session.googleCallsCount = (req.session.googleCallsCount || 0) + 1;
    }
    // use global fetch (Node 18+) or fallback to require('node-fetch') if needed
    const fetchFn =
      typeof fetch !== "undefined"
        ? fetch
        : (await import("node-fetch")).default;
    const gres = await fetchFn(url);
    const data = await gres.json();
    const items = data.items || [];
    const totalItems = parseInt(data.totalItems || items.length || 0, 10);

    // persist each item into books table (upsert on google_id)
    const upsertSql = `INSERT INTO books(google_id, title, authors_json, infoLink, cover, raw_json, fetched_at)
VALUES(?, ?, ?, ?, ?, ?, NOW())
                       ON DUPLICATE KEY UPDATE
title = VALUES(title),
  authors_json = VALUES(authors_json),
  infoLink = VALUES(infoLink),
  cover = VALUES(cover),
  raw_json = VALUES(raw_json),
  fetched_at = VALUES(fetched_at)`;

    const conn = await pool.getConnection();
    try {
      for (const item of items) {
        const googleId = item.id || null;
        const volume = item.volumeInfo || {};
        const title = volume.title || "";
        const authorsJson = JSON.stringify(volume.authors || []);
        const infoLink = volume.infoLink || "";
        const cover =
          (volume.imageLinks &&
            (volume.imageLinks.thumbnail ||
              volume.imageLinks.smallThumbnail)) ||
          "";
        const raw = JSON.stringify(item);
        if (!googleId) continue;
        await conn.query(upsertSql, [
          googleId,
          title,
          authorsJson,
          infoLink,
          cover,
          raw,
        ]);
      }
    } finally {
      conn.release();
    }

    // cache the items (store full version to preserve accessInfo)
    const compact = items.map((it) => ({
      id: it.id,
      volumeInfo: it.volumeInfo,
      accessInfo: it.accessInfo || {},
    }));
    setCached(key, { items: compact, totalItems });

    return res.json({
      fromCache: false,
      items: compact,
      totalItems,
      page,
      per_page,
    });
  } catch (err) {
    console.error("Search proxy error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// Cache endpoint: accept items fetched client-side and upsert into books table
app.post("/api/cache", async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items)
      ? req.body.items
      : [];
    // limit to 40 items to avoid huge payloads
    const safeItems = items.slice(0, 40);
    if (!safeItems.length) return res.json({ message: "no items" });

    const upsertSql = `INSERT INTO books(google_id, title, authors_json, infoLink, cover, raw_json, fetched_at)
VALUES(?, ?, ?, ?, ?, ?, NOW())
                       ON DUPLICATE KEY UPDATE
title = VALUES(title),
  authors_json = VALUES(authors_json),
  infoLink = VALUES(infoLink),
  cover = VALUES(cover),
  raw_json = VALUES(raw_json),
  fetched_at = VALUES(fetched_at)`;

    const conn = await pool.getConnection();
    try {
      for (const it of safeItems) {
        const googleId =
          it.id ||
          (it.volumeInfo &&
            it.volumeInfo.industryIdentifiers &&
            it.volumeInfo.industryIdentifiers[0] &&
            it.volumeInfo.industryIdentifiers[0].identifier) ||
          null;
        const volume = it.volumeInfo || {};
        const title = volume.title || "";
        const authorsJson = JSON.stringify(volume.authors || []);
        const infoLink = volume.infoLink || "";
        const cover =
          (volume.imageLinks &&
            (volume.imageLinks.thumbnail ||
              volume.imageLinks.smallThumbnail)) ||
          "";
        const raw = JSON.stringify(it);
        if (!googleId) continue;
        await conn.query(upsertSql, [
          googleId,
          title,
          authorsJson,
          infoLink,
          cover,
          raw,
        ]);
      }
    } finally {
      conn.release();
    }

    return res.json({ message: "ok", cached: safeItems.length });
  } catch (err) {
    console.error("/api/cache error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// return current session user info
app.get("/api/me", async (req, res) => {
  if (req.session && req.session.userId) {
    // Use email from session if available, otherwise fetch from DB
    let email = req.session.email;
    if (!email) {
      try {
        const [rows] = await pool.query(
          "SELECT email FROM users WHERE id = ?",
          [req.session.userId]
        );
        email = rows.length > 0 ? rows[0].email : null;
        // Cache in session for future requests
        if (email) req.session.email = email;
      } catch (err) {
        console.error("Error fetching user email:", err);
      }
    }
    return res.json({
      userId: req.session.userId,
      username: req.session.username || null,
      email: email || null,
    });
  }
  return res.json({ userId: null, username: null, email: null });
});

// logout
app.post("/api/logout", (req, res) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ message: "Failed to logout" });
      res.clearCookie(process.env.SESSION_NAME || "shelfcloud_sid");
      return res.json({ message: "ok" });
    });
  } else {
    return res.json({ message: "ok" });
  }
});

// Proxy download endpoint
app.get("/api/proxy-download", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing URL");

  try {
    // Basic validation to prevent open relay abuse (optional but good practice)
    // For now, we just check if it starts with http
    if (!url.startsWith("http")) return res.status(400).send("Invalid URL");

    const fetch = (await import("node-fetch")).default;
    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).send("Failed to fetch file");
    }

    // Forward headers
    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    const contentDisposition = response.headers.get("content-disposition");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    // Force download if not already set
    if (contentDisposition) {
      res.setHeader("Content-Disposition", contentDisposition);
    } else {
      // Guess extension - check URL first as Google often returns HTML for PDFs
      let ext = "bin";
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes(".pdf") || lowerUrl.includes("output=pdf")) {
        ext = "pdf";
      } else if (lowerUrl.includes(".epub")) {
        ext = "epub";
      } else if (contentType && contentType.includes("pdf")) {
        ext = "pdf";
      } else if (contentType && contentType.includes("epub")) {
        ext = "epub";
      }
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="download.${ext}"`
      );
    }

    // Stream the body (node-fetch v3 compatible)
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Proxy download error:", err);
    res.status(500).send("Server error during download");
  }
});

// Local DB Search
app.get("/api/local-search", async (req, res) => {
  let q = String(req.query.q || "").trim();
  q = q.replace(/\x00/g, "").slice(0, 200);

  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  let per_page = Math.max(1, parseInt(req.query.per_page || "20", 10));
  if (per_page > 40) per_page = 40;

  try {
    const offset = (page - 1) * per_page;
    // Simple LIKE search on title or authors
    const searchPattern = `%${q}%`;

    // Get items
    const [rows] = await pool.query(
      `SELECT google_id, title, authors_json, cover, infoLink, raw_json 
         FROM books 
         WHERE title LIKE ? OR authors_json LIKE ? 
         ORDER BY fetched_at DESC 
         LIMIT ? OFFSET ?`,
      [searchPattern, searchPattern, per_page, offset]
    );

    // Get total count for pagination
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as count 
       FROM books 
       WHERE title LIKE ? OR authors_json LIKE ?`,
      [searchPattern, searchPattern]
    );
    const totalItems = countRows[0].count;

    const items = rows.map((r) => {
      // If we have raw_json, try to use it to reconstruct the full object structure
      // otherwise fallback to the columns we have
      try {
        if (r.raw_json) return JSON.parse(r.raw_json);
      } catch (e) {}

      // fallback mapping
      let pub = "";
      try {
        if (r.raw_json) {
          const parsed = JSON.parse(r.raw_json);
          pub =
            parsed && parsed.volumeInfo && parsed.volumeInfo.publishedDate
              ? parsed.volumeInfo.publishedDate
              : "";
        }
      } catch (e) {}

      return {
        id: r.google_id,
        volumeInfo: {
          title: r.title,
          authors: JSON.parse(r.authors_json || "[]"),
          imageLinks: { thumbnail: r.cover },
          infoLink: r.infoLink,
          publishedDate: pub,
        },
      };
    });

    return res.json({
      items,
      totalItems,
      page,
      per_page,
    });
  } catch (err) {
    console.error("Local search error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// Fallback: redirect non-API unknown routes to home (prevents 404 pages)
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ message: "Not found" });
  }
  // serve index or redirect to root
  try {
    return res.sendFile(path.join(__dirname, "index.html"));
  } catch (e) {
    return res.redirect("/");
  }
});

const PORT = process.env.PORT || 3000;

// Initialize DB (if needed) then start server
(async function init() {
  await ensureDatabaseInitialized();
  app.listen(PORT, () => console.log(`Server running on port ${PORT} `));
})();
