# Contributing

Use Node 24.13+ on macOS or Linux. Run `npm ci`, then `npm run validate`. Changes should include a focused regression test for the behavior they alter. Use temporary directories and simulated executables for integration tests; live agent tests are manual and may consume account usage.

Keep scheduling separate from merge policy. RepoQ must never infer new merge authority, release a reservation on a timeout, or silently fork a conversation. Preserve existing state or document an explicit migration.

Use strict TypeScript and standard Node APIs before adding dependencies. Validate external data at its boundary. Keep command arguments separate from shell text and never commit real queue state, transcripts, tokens, account paths or session identifiers.

Before changing the agent skill, edit `skills/repo-queue/BASE.md`, update every supported complete variant, and exercise realistic agent decisions. Do not use string-matching tests as proof that prose produces the right behavior.

Include the observable behavior and validation in your pull request. Screenshots and logs must use synthetic data. Publication of a new package release is separate from merging source.
