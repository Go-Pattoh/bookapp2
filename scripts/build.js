#!/usr/bin/env node
/**
 * Simple build script: creates a `dist/` folder with static assets
 * and copies server entry. Intended for basic deploys.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyFile(srcRel, destRel) {
  const src = path.join(root, srcRel);
  const dest = path.join(dist, destRel);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(srcRel, destRel) {
  const src = path.join(root, srcRel);
  const dest = path.join(dist, destRel);
  ensureDir(dest);
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) {
      ensureDir(d);
      copyDir(path.join(srcRel, entry), path.join(destRel, entry));
    } else {
      ensureDir(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}

function main() {
  ensureDir(dist);
  // Copy static client files
  const staticFiles = [
    "index.html",
    "login.html",
    "register.html",
    "account.html",
    "about.html",
    "help.html",
    "lastlastA.css",
    "theme.js",
    "db.js",
    "googleapi_mod.js.js",
  ];
  staticFiles.forEach((f) => {
    if (fs.existsSync(path.join(root, f))) copyFile(f, f);
  });

  // Copy server entry
  copyFile("server.js", "server.js");

  // Copy scripts if needed
  if (fs.existsSync(path.join(root, "scripts"))) {
    copyDir("scripts", "scripts");
  }

  console.log("Built dist/ successfully.");
}

main();
