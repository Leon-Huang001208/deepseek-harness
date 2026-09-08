# Agent Note: Permanent Session deletion

Status: implemented

English | [中文](2026-09-08-permanent-session-deletion.zh.md)

## Problem

Session persistence could create, resume, list, and archive durable conversations, but it could not erase one. Products that offer a recoverable retention window still need a final operation that removes an expired or explicitly purged Session from the authoritative log and every derived owner. Deleting only a product index leaves private content in DSH; deleting only the log leaves search results, projection rows, and Workspace references that point to an identity which no longer exists.

A live Agent also makes deletion a lifecycle operation rather than a filesystem command. Removing storage while a loop is writing can corrupt the log or let an active identity continue after its durable history disappears. Subagent logs form a lineage whose descendants must not survive an ordinary parent deletion.

## Decision

The Session Controller publishes `session/delete` for permanent deletion of an ordinary Session. It discovers the complete persisted and live lineage, rejects a direct subagent target, orders descendants deepest-first with the requested root last, and performs one complete liveness preflight before changing derived or durable state. A running Agent, an in-progress create or resume, an attached Session without a controller-owned Agent handle, or a live Agent owned outside the controller returns a stable busy failure without mutation. An idle Agent whose handle belongs to the controller is disposed before cleanup.

For each target, the controller invalidates Session Query state, deletes its projection-cache row, removes Workspace and archive references, and then calls the persistence provider. The JSONL provider takes its process-local writer claim and stable cross-process lease before it removes every generation and temporary artifact. It retains the empty `session.lock` inode so a later create with the same id cannot defeat a process that still holds the original lock. Cancellation is honored before physical removal begins; after that point deletion finishes so the directory is not left half-pruned.

The root log is the final authoritative artifact removed. If a descendant cleanup fails, the root remains addressable and the caller can retry the cascade; descendants already removed simply disappear from the next discovery pass. A completed operation returns `deletedSessionIds` in the order applied. Calling the operation again after the root is gone returns `session/not-found`.

The generic `SessionPersistence.delete` method has a fail-closed default that rejects unsupported providers. A persistence implementation must opt in and prove its ownership, cancellation, and absence semantics before a Host can rely on deletion.

## Alternatives considered

**Let each embedding product delete DSH files directly.** Rejected because a product does not own persistence layout, format generations, writer leases, or derived DSH state. It would couple retention policy to private paths and make format evolution unsafe.

**Delete only the requested root and leave descendants.** Rejected because child Sessions can contain delegated user context and outputs. A parent-level retention promise must cover the complete lineage.

**Force-stop every live Agent during deletion.** Rejected because a delete request must not turn an active computation into an implicit cancellation. Busy and externally owned identities fail without mutation; the caller can cancel through the existing lifecycle API and retry after quiescence.

**Remove the stable lock file with the Session data.** Rejected because unlinking a held POSIX lock creates a second inode at the same path and permits a new writer while the old process still owns the first lock. Keeping an empty lock inode preserves exclusion without retaining Session content.

## Consequences

- Embedding products can implement retention windows and user-requested purges without knowing DSH storage internals.
- Permanent deletion includes subagent descendants, query indexes, projection caches, Workspace membership, archive references, and durable JSONL generations.
- The operation is intentionally unavailable for a direct subagent identity and intentionally non-forceful for active or externally owned Sessions.
- A failed cascade can require a retry. The root-last order keeps the retry identity available, but cleanup across independent owners is not a distributed transaction.
- Shared content-addressed artifacts remain governed by their own reference ownership; Session deletion removes Session-owned records and references, not unrelated consumers' data.

## Testing

The reusable persistence contract covers closed deletion, repeated absence, writer ownership, cancellation before commit, and fresh-instance visibility. JSONL tests exercise both raw and Zstandard roots and the cross-process lease. Session Controller tests cover deterministic descendant order, derived cleanup, direct-child refusal, running and externally owned live refusal, controller-owned idle disposal, repeated deletion, and zero mutation on preflight failure. Query, projection-cache, and Workspace tests pin their individual forget operations.
