CREATE DATABASE IF NOT EXISTS shelfcloud CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE shelfcloud;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(120) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS downloads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  google_id VARCHAR(255),
  title VARCHAR(1000),
  authors_json TEXT,
  cover VARCHAR(1000),
  infoLink VARCHAR(2000),
  publishedDate VARCHAR(50),
  accessInfo_json TEXT,
  saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- store fetched book metadata so the server can cache/persist results
CREATE TABLE IF NOT EXISTS books (
  id INT AUTO_INCREMENT PRIMARY KEY,
  google_id VARCHAR(255) NOT NULL UNIQUE,
  title VARCHAR(1000),
  authors_json TEXT,
  infoLink VARCHAR(2000),
  cover VARCHAR(1000),
  raw_json LONGTEXT,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (google_id)
);