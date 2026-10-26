/** Permanent Session deletion through the latest Typert Session Controller. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '../src/types.ts'
import {
  createSessionTestController,
  createSessionTestRemote,
  testSessionPersistence,
  type TestSessionRemote,
} from './test-remote.ts'

function header(id: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
    cwd: '/project',
    ...extra,
  }
}

type DeleteRemote = TestSessionRemote & {
  delete(request: { readonly sessionId: SessionIdType }): Promise<{
    readonly ok: true
    readonly value: { readonly deletedSessionIds: readonly SessionIdType[] }
  } | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: unknown }
  }>
}

function barrier() {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  return { entered: entered.promise, release: () => { released.resolve(undefined) }, wait: async () => {
    entered.resolve(undefined)
    await released.promise
  } }
}

async function harness(initial: readonly SessionHeader[], options: {
  readonly parents?: ReadonlyMap<SessionIdType, SessionIdType>
  readonly beforeDispose?: (id: SessionIdType) => Promise<void>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const stored = new Map(initial.map(meta => [meta.id, meta]))
  const deleted: SessionIdType[] = []
  const persistence = testSessionPersistence(ctx, {
    list: () => Promise.resolve([...stored.values()]),
    inspect: async (id: SessionIdType) => {
      const meta = stored.get(id)
      return meta === undefined ? undefined : { meta, events: [] }
    },
    delete: async (id: SessionIdType) => {
      if (!stored.delete(id)) throw new SessionPersistenceNotFoundError(id)
      deleted.push(id)
    },
  })
  ctx.provide('sessionPersistence', persistence as never)
  const forgetWorkspace = vi.fn<(id: SessionIdType) => Promise<void>>(() => Promise.resolve())
  ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [],
    forgetSession: forgetWorkspace,
  } as never)
  const deleteProjection = vi.fn<(id: SessionIdType) => Promise<boolean>>(() => Promise.resolve(true))
  ctx.provide('sessionProjectionCache', {
    delete: deleteProjection,
    hydratePrepared: (session: Session, events: readonly SessionEvent[]) =>
      ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0)),
  } as never)
  const disposed: SessionIdType[] = []
  const started = vi.fn()
  const resume = vi.fn(() => Promise.reject(new Error('delete harness resume reached')))
  const parents = options.parents ?? new Map<SessionIdType, SessionIdType>()
  const beforeDispose = options.beforeDispose
  const factory: AgentFactory = {
    async createAgent(ownerCtx, options) {
      const parent = parents.get(options.sessionId)
      const session = ctx.sessions.prepare(options.sessionId, {
        ...(options.seed === undefined ? {} : { seed: [...options.seed] }),
        ...(options.meta === undefined ? {} : { meta: {
          ...options.meta,
          ...(parent === undefined
            ? {}
            : { parentSession: parent }),
        } }),
        ...(options.inheritedEventCount === undefined
          ? {}
          : { inheritedEventCount: options.inheritedEventCount }),
      })
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id, session, status: 'idle', ctx: agentCtx,
        inbox: { nextTurn: [], nextStep: [] }, followup: started, steer: started,
      })
      await options.setup?.(agentCtx, agent)
      const detachSession = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const detachAgent = ctx.agents.enter(agent, undefined)
      await ctx.agents.announce(agent, 'startup')
      stored.set(session.id, session.header)
      return {
        agent,
        dispose: async () => {
          await beforeDispose?.(session.id)
          disposed.push(session.id)
          detachAgent()
          detachSession()
        },
      }
    },
    resume,
  }
  ctx.agents.setFactory(factory)
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/project',
  }) as DeleteRemote
  const controller = await createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/project',
  })
  const forgetQuery = vi.spyOn(ctx.sessionQuery, 'forgetSession')
  return { ctx, remote, controller, stored, deleted, disposed, started, resume, forgetWorkspace, deleteProjection, forgetQuery }
}

describe('sessions.delete', () => {
  it.each(['success', 'final-cleanup-failure'] as const)('settles SQLite rows refilled during workspace cleanup: %s', async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-delete-refill-'))
    const path = join(directory, 'search.db')
    const ctx = new Context()
    const gate = barrier()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions'), compression: 'none' })
      await ctx.plugin(SqliteSessionQueryEngine, { path })
      const meta = header('sqlite-refill')
      const writer = await ctx.sessionPersistence.create(meta)
      await writer.append([{
        type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
        data: createUserMessage({ content: [{ type: 'text', text: 'refillneedle' }], source: { kind: 'user' } }),
      }])
      await writer.close()
      ctx.provide('workspaceRegistry', {
        get: () => undefined, list: () => [], forgetSession: () => gate.wait(),
      } as never)
      const remote = await createSessionTestRemote(ctx, {
        defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: directory,
      })
      expect((await ctx.sessionQuery.searchSessions({ query: 'refillneedle' })).items).toHaveLength(1)
      const deleting = remote.delete({ sessionId: meta.id })
      await gate.entered
      try {
        expect((await ctx.sessionQuery.searchSessions({ query: 'refillneedle' })).items).toHaveLength(1)
        if (outcome === 'final-cleanup-failure') {
          vi.spyOn(ctx.sessionQuery, 'forgetSession').mockRejectedValueOnce(new Error('final index unavailable'))
        }
      } finally { gate.release() }
      const response = await deleting
      if (outcome === 'success') expect(response.ok).toBe(true)
      else {
        expect(response).toMatchObject({ ok: false, error: {
          code: 'session/delete-blocked',
          details: { sessionId: meta.id, reason: 'authoritative log deleted; final derived cleanup requires recovery' },
        } })
        expect(await remote.delete({ sessionId: meta.id })).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
      }
      expect(await ctx.sessionPersistence.stat(meta.id)).toBeUndefined()
      const db = new DatabaseSync(path)
      try {
        if (outcome === 'final-cleanup-failure') {
          expect(db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get(meta.id)).toBeDefined()
          await ctx.sessionQuery.forgetSession(meta.id)
        }
        expect(db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get(meta.id)).toBeUndefined()
      } finally { db.close() }
      expect((await ctx.sessionQuery.searchSessions({ query: 'refillneedle' })).items).toEqual([])
    } finally {
      gate.release()
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reserves every cascade identity while an earlier owned child is being disposed', async () => {
    const root = SessionId('reserved-root')
    const child = SessionId('reserved-child')
    const gate = barrier()
    const result = await harness([], { parents: new Map([[child, root]]), beforeDispose: async (id) => {
      if (id === child) await gate.wait()
    } })
    try {
      expect((await result.remote.create({ sessionId: root, cwd: process.cwd() })).ok).toBe(true)
      expect((await result.remote.create({ sessionId: child, cwd: process.cwd() })).ok).toBe(true)
      const deleting = result.remote.delete({ sessionId: root })
      await gate.entered
      try {
        expect(await result.remote.prompt({
          sessionId: root, requestId: 'during-delete' as SessionRequestId,
          content: [{ type: 'text', text: 'hello' }], mode: 'queue',
        })).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
        expect(await result.remote.delete({ sessionId: root })).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
        const resolved = await result.controller.resolveAgent(root)
        expect('error' in resolved ? resolved.error.code : undefined).toBe('session/agent-busy')
        expect(await result.remote.create({ sessionId: root, cwd: process.cwd() })).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
      } finally { gate.release() }
      expect((await deleting).ok).toBe(true)
      expect(result.disposed).toEqual([child, root])
      expect(result.started).not.toHaveBeenCalled()
    } finally { gate.release(); await result.ctx.fiber.dispose() }
  })

  it('refuses deletion while a prompt already owns attachment admission', async () => {
    const sessionId = SessionId('prompt-before-delete')
    const gate = barrier()
    const result = await harness([])
    try {
      expect((await result.remote.create({ sessionId, cwd: process.cwd() })).ok).toBe(true)
      vi.spyOn(result.ctx.attachments, 'admitPromptContent').mockImplementationOnce(async (content) => {
        await gate.wait()
        return content.filter(part => part.type === 'text')
      })
      const prompting = result.remote.prompt({
        sessionId, requestId: 'before-delete' as SessionRequestId,
        content: [{ type: 'text', text: 'hello' }], mode: 'queue',
      })
      await gate.entered
      try {
        expect(await result.remote.delete({ sessionId })).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
        expect(result.disposed).toEqual([])
        expect(result.forgetQuery).not.toHaveBeenCalled()
      } finally { gate.release() }
      expect((await prompting).ok).toBe(true)
      expect(result.started).toHaveBeenCalledOnce()
    } finally { gate.release(); await result.ctx.fiber.dispose() }
  })

  it('rechecks each owned Agent after an earlier child disposal await', async () => {
    const root = SessionId('external-start-root')
    const child = SessionId('external-start-child')
    const gate = barrier()
    const result = await harness([], { parents: new Map([[child, root]]), beforeDispose: async (id) => {
      if (id === child) await gate.wait()
    } })
    try {
      expect((await result.remote.create({ sessionId: root, cwd: process.cwd() })).ok).toBe(true)
      expect((await result.remote.create({ sessionId: child, cwd: process.cwd() })).ok).toBe(true)
      const deleting = result.remote.delete({ sessionId: root })
      await gate.entered
      const running = result.ctx.agents.get(root)
      if (running === undefined) throw new Error('root agent missing during child disposal')
      Object.assign(running, { status: 'running' })
      gate.release()
      expect(await deleting).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
      expect(result.disposed).toEqual([child])
      expect(result.ctx.agents.get(root)?.status).toBe('running')
      expect(result.forgetQuery).not.toHaveBeenCalled()
      expect(result.deleted).toEqual([])
      const resolved = await result.controller.resolveAgent(root)
      expect('agent' in resolved).toBe(true)
      Object.assign(running, { status: 'idle' })
      expect((await result.remote.delete({ sessionId: root })).ok).toBe(true)
    } finally { gate.release(); await result.ctx.fiber.dispose() }
  })

  it.each(['success', 'failure', 'cancel'] as const)('holds a cold identity through derived cleanup and releases after %s', async (outcome) => {
    const root = header(`cold-${outcome}`)
    const gate = barrier()
    const result = await harness([root])
    const abort = new AbortController()
    result.forgetWorkspace.mockImplementationOnce(async () => {
      await gate.wait()
      if (outcome === 'failure') throw new Error('workspace cleanup failed')
      if (outcome === 'cancel') abort.abort()
    })
    try {
      const deleting = result.controller.delete({ sessionId: root.id }, abort.signal)
      const settled = deleting.then(value => ({ value }), (error: unknown) => ({ error }))
      await gate.entered
      try {
        const resolved = await result.controller.resolveAgent(root.id)
        expect('error' in resolved ? resolved.error.code : undefined).toBe('session/agent-busy')
        expect(result.resume).not.toHaveBeenCalled()
      } finally { gate.release() }
      const response = await settled
      if (outcome === 'success') expect(response).toMatchObject({ value: { deletedSessionIds: [root.id] } })
      else expect(response).toHaveProperty('error')
      const after = await result.controller.resolveAgent(root.id)
      expect('error' in after ? after.error.code : undefined).not.toBe('session/agent-busy')
      if (outcome !== 'success') {
        expect(result.resume).toHaveBeenCalledOnce()
        expect((await result.remote.delete({ sessionId: root.id })).ok).toBe(true)
      }
      expect((await result.remote.create({ sessionId: root.id, cwd: process.cwd() })).ok).toBe(true)
    } finally { gate.release(); await result.ctx.fiber.dispose() }
  })

  it('refuses a cascade containing a descendant outside caller access before any mutation', async () => {
    const root = header('root')
    const child = header('private-child', { parentSession: root.id, origin: 'subagent', delegationDepth: 1 })
    const result = await harness([root, child])
    vi.spyOn(result.ctx.remoteAccess, 'allows').mockImplementation(resource => resource.kind !== 'session' || resource.id !== child.id)
    try {
      const response = await result.remote.delete({ sessionId: root.id })
      expect(response).toMatchObject({ ok: false, error: { code: 'session/delete-blocked' } })
      expect(result.deleted).toEqual([])
      expect(result.forgetQuery).not.toHaveBeenCalled()
      expect(result.deleteProjection).not.toHaveBeenCalled()
      expect(result.forgetWorkspace).not.toHaveBeenCalled()
    } finally { await result.ctx.fiber.dispose() }
  })

  it('deletes descendants deepest-first and cleans every derived owner', async () => {
    const root = header('root')
    const child = header('child', { parentSession: root.id, origin: 'subagent', delegationDepth: 1 })
    const grandchild = header('grandchild', { parentSession: child.id, origin: 'subagent', delegationDepth: 2 })
    const unrelated = header('unrelated')
    const result = await harness([root, child, grandchild, unrelated])

    const response = await result.remote.delete({ sessionId: root.id })

    expect(response).toEqual({
      ok: true,
      value: { deletedSessionIds: [grandchild.id, child.id, root.id] },
    })
    expect(result.deleted).toEqual([grandchild.id, child.id, root.id])
    expect([...result.stored.keys()]).toEqual([unrelated.id])
    expect(result.forgetQuery.mock.calls.map(([id]) => id)).toEqual(result.deleted.flatMap(id => [id, id]))
    expect(result.deleteProjection.mock.calls.map(([id]) => id)).toEqual(result.deleted.flatMap(id => [id, id]))
    expect(result.forgetWorkspace.mock.calls.map(([id]) => id)).toEqual(result.deleted)
    await result.ctx.fiber.dispose()
  })

  it('rejects a direct subagent deletion and a repeated missing root', async () => {
    const root = header('root')
    const child = header('child', { parentSession: root.id, origin: 'subagent', delegationDepth: 1 })
    const result = await harness([root, child])

    const childResponse = await result.remote.delete({ sessionId: child.id })
    expect(childResponse).toMatchObject({ ok: false, error: { code: 'session/delete-blocked' } })
    expect(result.deleted).toEqual([])

    expect((await result.remote.delete({ sessionId: root.id })).ok).toBe(true)
    const repeated = await result.remote.delete({ sessionId: root.id })
    expect(repeated).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    await result.ctx.fiber.dispose()
  })

  it('refuses a busy live root without mutating persistence or derived state', async () => {
    const root = header('busy')
    const result = await harness([root])
    const session = result.ctx.sessions.create(root.id, { meta: { cwd: '/project' } })
    result.ctx.agents.register({ id: root.id, session, status: 'running', ctx: result.ctx } as never)

    const response = await result.remote.delete({ sessionId: root.id })

    expect(response).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    expect(result.deleted).toEqual([])
    expect(result.forgetQuery).not.toHaveBeenCalled()
    expect(result.deleteProjection).not.toHaveBeenCalled()
    expect(result.forgetWorkspace).not.toHaveBeenCalled()
    await result.ctx.fiber.dispose()
  })

  it('refuses an idle live root owned outside the Session Controller', async () => {
    const root = header('external-idle')
    const result = await harness([root])
    const session = result.ctx.sessions.create(root.id, { meta: { cwd: '/project' } })
    result.ctx.agents.register({ id: root.id, session, status: 'idle', ctx: result.ctx } as never)

    const response = await result.remote.delete({ sessionId: root.id })

    expect(response).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    expect(result.deleted).toEqual([])
    expect(result.forgetQuery).not.toHaveBeenCalled()
    await result.ctx.fiber.dispose()
  })

  it('releases an idle controller-owned live root before deleting durable state', async () => {
    const result = await harness([])
    const sessionId = SessionId('controller-owned')
    const created = await result.remote.create({ sessionId, cwd: process.cwd() })
    if (!created.ok) throw new Error(`create failed: ${created.error.code}: ${created.error.message}`)
    expect(created).toMatchObject({ ok: true, value: { sessionId } })
    expect(result.ctx.agents.get(sessionId)).toBeDefined()
    expect(result.ctx.sessions.get(sessionId)).toBeDefined()

    const response = await result.remote.delete({ sessionId })

    expect(response).toEqual({ ok: true, value: { deletedSessionIds: [sessionId] } })
    expect(result.ctx.agents.get(sessionId)).toBeUndefined()
    expect(result.ctx.sessions.get(sessionId)).toBeUndefined()
    expect(result.deleted).toEqual([sessionId])
    await result.ctx.fiber.dispose()
  })
})
