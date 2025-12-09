CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_address TEXT NOT NULL,
    alias TEXT,
    script_url TEXT,
    refresh_token TEXT,
    status INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS send_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_email_id INTEGER,
    target_emails TEXT,
    content TEXT,
    schedule_base_time DATETIME, 
    delay_rule TEXT, 
    is_loop INTEGER DEFAULT 0,
    next_run_time INTEGER,
    status TEXT DEFAULT 'pending'
);


CREATE TABLE IF NOT EXISTS received_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER,
    subject TEXT,
    snippet TEXT,
    full_content TEXT,
    received_at DATETIME
);
