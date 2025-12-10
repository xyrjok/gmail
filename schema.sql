-- 1. 账号表 (区分 GAS 和 API)
CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    alias       TEXT,
    type        TEXT CHECK(type IN ('GAS', 'API')) NOT NULL,
    script_url  TEXT, -- GAS的Web App URL 或 API的Token信息
    config_json TEXT, -- 存储API相关的额外配置 (Client ID/Secret/Token)
    status      INTEGER DEFAULT 1 -- 1启用 0禁用
);


-- 2. 邮件发送任务表 (核心循环逻辑)
CREATE TABLE IF NOT EXISTS send_tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER,
    to_email        TEXT NOT NULL,
    content         TEXT,
    schedule_type   TEXT, -- 'fixed' (固定时间) 或 'dynamic' (动态计算)
    base_date       DATETIME, -- A框: 基础日期
    delay_config    TEXT, -- B框: 延迟规则 (例如 "10-20")
    next_run_at     INTEGER, -- 下次运行的时间戳
    is_loop         INTEGER DEFAULT 0, -- 是否循环
    status          TEXT DEFAULT 'pending', -- pending, success, failed
    execution_mode  TEXT DEFAULT 'AUTO',
    subject         TEXT
);


-- 3. 收件箱 (简单存储)
CREATE TABLE IF NOT EXISTS received_emails (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER,
    sender      TEXT,
    subject     TEXT,
    body        TEXT,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    id_str      TEXT
);

-- 创建独立的认证信息表
CREATE TABLE IF NOT EXISTS account_auth (
    account_id INTEGER PRIMARY KEY,
    client_id TEXT,
    client_secret TEXT,
    refresh_token TEXT,
    updated_at INTEGER
);
