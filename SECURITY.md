# Security

RepoQ coordinates trusted agents running under one local OS account. It is not a security boundary between those agents. Another process running as that user can read or modify queue state and tokens.

PR URLs are parsed locally; RepoQ does not fetch arbitrary URLs. Agent commands use argument arrays, not shell interpolation. State is private to the OS account and must remain on a local filesystem. Keep it out of repositories, backups you share, and issue attachments.

RepoQ uses Node's standard libraries, including native SQLite. It does not store provider authentication credentials or confer merge authority. The configured agent CLI retains its own permission and authentication behavior.

For a sensitive report, use this repository's private vulnerability reporting when available. Do not put credentials, live queue databases or conversation transcripts in public issues. A redacted reproduction using temporary state is preferable.
