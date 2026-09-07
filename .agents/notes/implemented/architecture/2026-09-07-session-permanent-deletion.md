# Agent Note: irreversible session deletion boundary

Status: implemented

English | [中文](2026-09-07-session-permanent-deletion.zh.md)

## Problem

Workspace archiving deliberately hides a Session without touching its durable event log, derived query rows, projection cache, or workspace account. A product-level retention policy therefore cannot use archive as permanent deletion: doing so retains user data indefinitely and provides no confirmation that the primary DSH record is gone. Deleting only a product's local index has the same defect, while deleting a live Session races an agent that can still append events.

## Decision

Expose irreversible deletion as the explicit `session.delete({ sessionId, cascade? })` Host RPC. The gateway resolves persisted and live lineage, requires cascade when descendants exist, and preflights the complete target set before changing state. A target that is being created, has a running agent, or has a live agent not owned by this API instance is rejected with `session-delete-blocked`. API-owned idle handles are disposed first so persistence retirement reaches quiescence before storage changes begin.

Cleanup proceeds child-first across derived and primary stores. For each target, the gateway removes session-query rows, the projection-cache cell, workspace membership and archive references, then calls `SessionPersistence.delete()` last. JSONL unlinks only the exact backend-resolved transcript and removes only its now-empty container; SQLite deletes the session row in a transaction and relies on its foreign key to cascade event rows. A missing root remains an idempotent success, and the response lists every deleted Session id so callers can require explicit native confirmation before erasing their own tombstone.

DSH owns the deletion primitive, not a retention scheduler. A calling product owns any recoverable grace period, records a tombstone during that period, and invokes `session.delete` at expiry or after an explicit permanent-delete action. If derived cleanup fails, the primary record remains and the caller can retry; after primary deletion succeeds, restoration is no longer possible.

## Consequences

- Archive remains the reversible presentation operation and is not redefined as deletion.
- First-party persistence providers implement the same cold-session deletion contract, including safe idempotent retries for absent or never-materialized ids.
- Derived session-query, projection-cache, and workspace state no longer retain references after a confirmed host deletion.
- A product can state a finite retention policy without giving DSH product-specific timing or background-job policy.
- The operation is intentionally conservative around live ownership; a blocked deletion must be retried after the owning runtime reaches a safe state or restarts.

## Alternatives considered

- **Use workspace archive as deletion** — rejected because archive is reversible and intentionally preserves the event log and workspace accounting.
- **Delete only the product-side session index** — rejected because DSH transcripts and derived state would remain indefinitely.
- **Recursively remove a session directory** — rejected because broad filesystem deletion expands the damage surface and can cross links; the JSONL provider unlinks only its exact artifact.
- **Force-delete live Sessions** — rejected because a live agent can append after or during cleanup, making the deletion claim false.
- **Put a 30-day scheduler in DSH** — rejected because grace periods, restoration UX, and retention policy belong to the calling product; DSH supplies the irreversible primitive and its safety boundary.
