// db.js - SQLite helper (auto create db + tables)
// No external API limits. No website needed.

const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const path = require("path");
const fs = require("fs");

let db = null;

async function initDB() {
  // Ensure /db folder exists
  const dbDir = path.join(__dirname, "db");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, "database.sqlite");

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Users table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE,
      password_hash TEXT,
      created_at TEXT
    );
  `);

  // Signals table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal INTEGER,
      symbol TEXT,
      action TEXT,
      price TEXT,
      timeframe TEXT,
      user_id TEXT,
      tv_signal_id TEXT,
      received_at TEXT
    );
  `);

  // Helpful index
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_user_time ON signals(user_id, received_at);`);

  console.log("✅ SQLite DB ready at:", dbPath);
}

function getDB() {
  return db;
}

module.exports = { initDB, getDB };

