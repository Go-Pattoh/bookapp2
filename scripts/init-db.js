#!/usr/bin/env node
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

(async () => {
  try {
    const sqlPath = path.join(__dirname, "..", "db.js");
    const sql = fs.readFileSync(sqlPath, "utf8");

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

    const conn = await mysql.createConnection(connOptions);

    console.log("Running DB initialization SQL...");
    await conn.query(sql);
    console.log("Database initialized successfully.");
    await conn.end();
  } catch (err) {
    console.error("Failed to initialize DB:", err.message || err);
    process.exit(1);
  }
})();
