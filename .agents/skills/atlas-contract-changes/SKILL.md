---
name: atlas-contract-changes
description: Use when changing Atlas shared schemas, HTTP payloads, Worker WebSocket messages, or persisted data that affects consumers across apps.
---

# Atlas contract changes

Work from the repository root. Read `AGENTS.md`, the affected app instructions,
`packages/contracts/AGENTS.md`, and `docs/development/protocol.md`. The root
instructions are the source of truth for test permissions and app ownership.

## Trace the change

Before editing, locate the schema, its public exports, producers, consumers,
fixtures and persistence readers with `rg`. Identify which of Board, API and
Worker are affected. Review the proposed shape against each consumer before
changing it; coordination does not require spawning agents.

Check more than TypeScript compatibility: strict runtime validators may reject
added fields, SQLite may retain old rows, and the Worker journal may replay a
message written before the update. Decide whether the change is compatible,
requires a migration, or requires a coordinated restart/protocol version change.
Document the decision in `docs/development/protocol.md` when behavior or
compatibility changes. Do not erase local data or journals to bypass migration.

## Update the affected path

Keep schemas and inferred types in `packages/contracts`, exported through its
public entrypoint. Update producers, validators and consumers together. Keep
application rules in the API and filesystem execution in the Worker.

Identify needed fixture and test changes before editing them. Follow the root
permission rule, reuse authorization already given for the exact change, and
continue independent production work while approval is pending.

For command changes, preserve command identity on redelivery, durable results
before acknowledgement, and safe handling of journal replay. Check unsupported
messages explicitly rather than silently accepting a new shape.

## Verify and report

Build contracts before consumers: `pnpm --filter @atlas/contracts build`.
Run relevant package checks and integration scenarios, then `pnpm check` before
claiming shared work complete. Use the `atlas-feature-verification` skill for
browser or real API/Worker coverage when the affected behavior needs it.

Report the changed contract, affected consumers, compatibility decision and
actual verification results. Identify any approval or environment blockers.

Example: adding a repository command result field requires checking the Worker
producer and journal, API result validator and persistence, and any Board display
that reads the operation; changing only the exported type is insufficient.
