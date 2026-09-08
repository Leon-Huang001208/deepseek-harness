/** Permanent Session deletion through the latest Typert Session Controller. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import {
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

async function harness(initial: readonly SessionHeader[]) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const stored = new Map(initial.map(meta => [meta.id, meta]))
  const deleted: SessionIdType[] = []
  const persistence = testSessionPersistence(ctx, {
    list: () => Promise.resolve([...stored.values()]),
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
  ctx.provide('sessionProjectionCache', { delete: deleteProjection } as never)
  const factory: AgentFactory = {
    async createAgent(ownerCtx, options) {
      const session = ctx.sessions.prepare(options.sessionId, {
        ...(options.seed === undefined ? {} : { seed: [...options.seed] }),
        ...(options.meta === undefined ? {} : { meta: options.meta }),
        ...(options.inheritedEventCount === undefined
          ? {}
          : { inheritedEventCount: options.inheritedEventCount }),
      })
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, { id: session.id, session, status: 'idle', ctx: agentCtx })
      await options.setup?.(agentCtx)
      const detachSession = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const detachAgent = ctx.agents.enter(agent, undefined)
      ctx.agents.announce(agent)
      stored.set(session.id, session.header)
      return {
        agent,
        dispose: async () => {
          detachAgent()
          detachSession()
        },
      }
    },
    resume: () => Promise.reject(new Error('delete harness does not resume persisted sessions')),
  }
  ctx.agents.setFactory(factory)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/project',
  }) as DeleteRemote
  const forgetQuery = vi.spyOn(ctx.sessionQuery, 'forgetSession')
  return { ctx, remote, stored, deleted, forgetWorkspace, deleteProjection, forgetQuery }
}

describe('sessions.delete', () => {
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
    expect(result.forgetQuery.mock.calls.map(([id]) => id)).toEqual(result.deleted)
    expect(result.deleteProjection.mock.calls.map(([id]) => id)).toEqual(result.deleted)
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
