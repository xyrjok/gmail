-- 1. 账号表 (区分 GAS 和 API)
CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    alias       TEXT,
    type        TEXT CHECK (type IN ('GAS', 'API', 'API/GAS')) NOT NULL,
    script_url  TEXT,
    config_json TEXT,
    status      INTEGER DEFAULT 1
);

-- 2. 邮件发送任务表 (核心循环逻辑)
CREATE TABLE IF NOT EXISTS send_tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER,
    to_email        TEXT NOT NULL,
    content         TEXT,
    schedule_type   TEXT,
    base_date       DATETIME,
    delay_config    TEXT,
    next_run_at     INTEGER,
    is_loop         INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'pending',
    execution_mode  TEXT DEFAULT 'AUTO',
    subject         TEXT,
    success_count   INTEGER DEFAULT 0,
    fail_count      INTEGER DEFAULT 0
);

-- 3. 收件箱 (简单存储)
CREATE TABLE IF NOT EXISTS received_emails (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   INTEGER,
    sender       TEXT,
    recipient    TEXT,
    subject      TEXT,
    body         TEXT,
    received_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    id_str       TEXT
);

-- 创建独立的认证信息表
CREATE TABLE IF NOT EXISTS account_auth (
    account_id     INTEGER PRIMARY KEY,
    client_id      TEXT,
    client_secret  TEXT,
    refresh_token  TEXT,
    updated_at     INTEGER
);

CREATE TABLE IF NOT EXISTS access_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    alias           TEXT NOT NULL,
    query_code      TEXT NOT NULL UNIQUE,
    fetch_limit     INTEGER DEFAULT 5,
    valid_until     INTEGER,
    match_sender    TEXT,
    match_receiver  TEXT,
    match_body      TEXT,
    created_at      INTEGER DEFAULT (strftime('%s', 'now'))
);
