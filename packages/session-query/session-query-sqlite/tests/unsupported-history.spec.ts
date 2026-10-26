/** Real Loader composition reads supported history without mutating an unsupported predecessor. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId, SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generationLogPath } from '../../../session/session-persistence-jsonl/src/format.ts'

it('reports real descriptor-v2 refusal through a YAML Loader composition without publishing a successor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-query-unsupported-'))
  const ctx = new Context()
  try {
    const store = join(root, 'sessions')
    const old = SessionId('old-descriptor')
    const artifact = generationLogPath(store, undefined, old, 0, 'none')
    await mkdir(dirname(artifact), { recursive: true })
    const original = [
      { type: 'session', version: 0, id: old, createdAt: 1, delegationDepth: 0 },
      { type: 'subagent/descriptor', seq: 0, time: 2, data: { version: 2, mode: 'one-shot', provider: 'spawn' } },
    ].map(row => JSON.stringify(row) + '\n').join('')
    await writeFile(artifact, original)
    const before = await stat(artifact)
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      '- name: cordis:session',
      '- name: cordis:projection',
      '- name: cordis:persistence',
      '  config:',
      `    root: ${JSON.stringify(store)}`,
      '    compression: none',
      '- name: cordis:query',
      '  config:',
      "    path: ':memory:'",
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      session: SessionStore,
      projection: SessionProjectionRegistry,
      persistence: JsonlSessionPersistence,
      query: SqliteSessionQueryEngine,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    const good = SessionId('readable')
    const writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: good, createdAt: 2, isSeeded: false })
    await writer.append([{
      type: 'user/message', seq: SessionSeq(0), time: 3, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'compatibility needle' }], source: { kind: 'user' } }),
    }])
    await writer.close()
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
    const page = await ctx.sessionQuery.searchSessions({ query: 'needle', unsupportedSessionPolicy: 'report' })
    expect(page.items.map(hit => hit.header.id)).toEqual([good])
    expect(page.unavailableSessions).toEqual([{ sessionId: old, reason: 'unsupported-format' }])
    expect(JSON.stringify(page)).not.toContain(artifact)
    expect(await readFile(artifact, 'utf8')).toBe(original)
    expect((await stat(artifact)).mtimeMs).toBe(before.mtimeMs)
    expect(await readdir(dirname(artifact))).toEqual(['session.jsonl'])
    await expect(ctx.sessionPersistence.open(old, 'read')).rejects.toThrow('unsupported descriptor version 2')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
