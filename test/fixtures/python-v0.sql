CREATE TABLE entries (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    agent TEXT NOT NULL,
    task TEXT NOT NULL,
    cwd TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('waiting', 'reserved', 'claimed', 'blocked', 'done')
    ),
    token TEXT,
    block_reason TEXT NOT NULL DEFAULT '',
    delivery_status TEXT NOT NULL CHECK (
        delivery_status IN ('pending', 'sending', 'sent', 'failed', 'uncertain')
    ),
    delivery_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (repo, pr_number)
);
INSERT INTO entries VALUES (
    1,
    '22222222-2222-4222-8222-222222222222',
    'https://github.com/example/legacy/pull/7',
    'github',
    'github.com/example/legacy',
    7,
    'codex',
    '11111111-1111-4111-8111-111111111111',
    '/work/legacy',
    'waiting',
    NULL,
    '',
    'pending',
    '',
    '2026-01-01T00:00:00.000000+00:00',
    '2026-01-01T00:00:00.000000+00:00'
);
CREATE INDEX entries_repo_state_sequence ON entries (repo, state, sequence);
