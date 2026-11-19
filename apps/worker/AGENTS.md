# Worker instructions

Follow the root [workspace instructions](../../AGENTS.md). The Worker owns its outbound WebSocket connection, command journal and local Git operations. Enforce workspace path confinement, journal before execution, and preserve evidence for recovery. Run Git with argument arrays and keep real filesystem tests on temporary roots. Verify reconnect, duplicate delivery and recovery with the Worker tests.
