# API instructions

Follow the root [workspace instructions](../../AGENTS.md). The API owns Fastify HTTP and WebSocket routes, SQLite migrations and data, application validation and command dispatch. Use shared schemas at boundaries, enforce field locks and revisions against persisted task state, and keep ordering and command state transitions transactional. Verify with API tests and a simulated Worker.
