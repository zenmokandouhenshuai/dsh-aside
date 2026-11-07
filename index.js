/**
 * Host half of 旁问 (aside): a tiny term-lookup service plus its on-disk archive.
 *
 * Routes (all JSON, all behind the same Origin as the app):
 *
 *   GET  /dsh-aside/list        archive + the route that would answer
 *   POST /dsh-aside/ask         { question, context, site } -> one new entry
 *   POST /dsh-aside/delete      { id } -> remove one entry
 *   GET  /dsh-aside/health      what is mounted and which route resolves
 *   POST /dsh-aside/route       { mode: 'dp' | 'auto', provider?, model? }
 *
 * The answer route is a stored preference, not a compile-time constant, so
 * switching between the cheap relay (`dp`) and the official account (`auto`,
 * which follows the app's default model) is one click and needs no restart.
 *
 * Storage is $DSH_HOME/dsh-aside/{config,asides}.json: plain text, survives
 * restarts and plugin removal, and never joins the session log, so side answers
 * never enter the main prompt.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'dsh-aside')
const STATE_FILE = path.join(STATE_DIR, 'asides.json')
const CONFIG_FILE = path.join(STATE_DIR, 'config.json')

const MAX_ITEMS = 500
const MAX_QUESTION = 400
const MAX_CONTEXT = 3000
const MAX_ANSWER = 4000
const MAX_BODY = 256 * 1024
const ANSWER_TIMEOUT_MS = 45_000
const MAX_TOKENS = 400

/** The relay this profile already uses; the official route is `mode: 'auto'`. */
const RELAY_ROUTE = { provider: 'dp', model: 'deepseek-v4.1-flash-1017' }

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

const SYSTEM_PROMPT = [
  '你是术语速查助手。用户正在写论文或做研究，他会把卡住的一个名词丢给你。',
  '只解释被问到的那个词或短语，不要展开成教程。',
  '写法：中文，最多三句；第一句给定义，第二、三句给一句用途或代价。',
  '不要复述问题，不要寒暄，不要用列表、标题或 Markdown 记号。',
  '上下文只是用来判断这个词在这里的含义，不足以判断时按该领域最常见的含义解释。',
].join('')

function emptyState() {
  return { version: 1, items: [] }
}

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const question = clip(raw.question, MAX_QUESTION).trim()
  const answer = clip(raw.answer, MAX_ANSWER).trim()
  const id = clip(raw.id, 64)
  if (!id || !question) return null
  return {
    id,
    question,
    answer,
    context: clip(raw.context, MAX_CONTEXT),
    site: clip(raw.site, 120),
    createdAt: finite(raw.createdAt, Date.now()),
  }
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!parsed || !Array.isArray(parsed.items)) return emptyState()
    return { version: 1, items: parsed.items.map(sanitizeItem).filter(Boolean) }
  } catch (err) {
    return emptyState()
  }
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

function writeState(state) {
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2))
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    return {}
  }
}

function writeConfig(config) {
  writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('payload too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** What the app would answer with if nobody pinned a route. */
function defaultModelRoute(ctx) {
  try {
    const service = ctx.get('agentDefaultModel')
    const selection = service && typeof service.currentSelection === 'function'
      ? service.currentSelection()
      : undefined
    const provider = selection && (selection.provider || (selection.selection && selection.selection.provider))
    const model = selection && (selection.model || (selection.selection && selection.selection.model))
    if (typeof provider === 'string' && typeof model === 'string' && provider && model) {
      return { provider, model }
    }
  } catch (err) {
    // A profile without agent-default-model simply has no opinion.
  }
  return null
}

/**
 * Resolve the route the card answers with.
 *
 *   mode 'dp'   the stored/provider relay route (default: this profile's dp)
 *   mode 'auto' the app's default model, i.e. the official account route
 */
function resolveRoute(ctx) {
  const config = readConfig()
  const mode = config.mode === 'auto' ? 'auto' : 'dp'
  if (mode === 'dp') {
    const provider = clip(config.provider, 60) || RELAY_ROUTE.provider
    const model = clip(config.model, 120) || RELAY_ROUTE.model
    return { provider, model, mode, label: 'dp 中转', source: 'stored' }
  }
  const live = defaultModelRoute(ctx)
  if (live) return { ...live, mode, label: '官方账号', source: 'agent-default-model' }
  return { ...RELAY_ROUTE, mode, label: 'dp 中转（默认模型不可用）', source: 'fallback' }
}

async function answerOnce(ctx, route, question, context) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('this profile has no llm service, so the aside card cannot answer')
  }
  const userText = context
    ? '上下文：「' + context + '」\n问题：' + question
    : '问题：' + question

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS)
  let text = ''
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      maxTokens: MAX_TOKENS,
      temperature: 0.3,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      } else if (chunk && chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
          const detail = reason.failure && reason.failure.message
          throw new Error(detail || ('model call ended as ' + reason.kind))
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }
  const answer = text.trim()
  if (!answer) throw new Error('the model returned an empty answer')
  return answer
}

export const inject = ['webServer']

export function apply(ctx) {
  // First run: record the intended route instead of leaving it implicit, so the
  // panel shows a real choice rather than a guess.
  try {
    if (!fs.existsSync(CONFIG_FILE)) writeConfig({ mode: 'dp', ...RELAY_ROUTE })
  } catch (err) {
    // A read-only home directory still leaves the in-memory default in place.
  }

  function rejected(req, res) {
    try {
      const conn = ctx.get('connection')
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch (err) {
      return false
    }
  }

  function send(res, status, payload) {
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  }

  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-aside/health',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      const route = resolveRoute(ctx)
      send(res, 200, {
        ok: true,
        route,
        store: STATE_FILE,
        config: CONFIG_FILE,
        count: readState().items.length,
      })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-aside/list',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const state = readState()
      send(res, 200, { ok: true, items: state.items, route: resolveRoute(ctx) })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-aside/route',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        send(res, 400, { ok: false, error: 'bad request body' })
        return
      }
      const mode = body && body.mode === 'auto' ? 'auto' : 'dp'
      const next = { mode }
      if (mode === 'dp') {
        next.provider = clip(body && body.provider, 60) || RELAY_ROUTE.provider
        next.model = clip(body && body.model, 120) || RELAY_ROUTE.model
      }
      try {
        writeConfig(next)
      } catch (err) {
        send(res, 500, { ok: false, error: 'config write failed: ' + String((err && err.message) || err).slice(0, 200) })
        return
      }
      send(res, 200, { ok: true, route: resolveRoute(ctx) })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-aside/ask',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        send(res, 400, { ok: false, error: 'bad request body: ' + String((err && err.message) || err).slice(0, 200) })
        return
      }
      const question = clip(body && body.question, MAX_QUESTION).trim()
      if (!question) {
        send(res, 400, { ok: false, error: 'question is required' })
        return
      }
      const context = clip(body && body.context, MAX_CONTEXT).trim()
      const site = clip(body && body.site, 120).trim()
      const route = resolveRoute(ctx)
      let answer
      try {
        answer = await answerOnce(ctx, route, question, context)
      } catch (err) {
        send(res, 502, {
          ok: false,
          error: String((err && err.message) || err).slice(0, 400),
          route,
        })
        return
      }
      const item = {
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        question,
        answer: answer.slice(0, MAX_ANSWER),
        context,
        site,
        createdAt: Date.now(),
      }
      const state = readState()
      state.items.unshift(item)
      state.items = state.items.slice(0, MAX_ITEMS)
      try {
        writeState(state)
      } catch (err) {
        send(res, 500, { ok: false, error: 'store write failed: ' + String((err && err.message) || err).slice(0, 200) })
        return
      }
      send(res, 200, { ok: true, item, route })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-aside/delete',
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        send(res, 400, { ok: false, error: 'bad request body' })
        return
      }
      const id = clip(body && body.id, 64)
      if (!id) {
        send(res, 400, { ok: false, error: 'id is required' })
        return
      }
      const state = readState()
      const before = state.items.length
      state.items = state.items.filter((item) => item.id !== id)
      try {
        writeState(state)
      } catch (err) {
        send(res, 500, { ok: false, error: 'store write failed' })
        return
      }
      send(res, 200, { ok: true, removed: before - state.items.length })
    },
  }))

  return ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch (err) { /* already gone */ }
    }
  }, 'dsh-aside: routes')
}