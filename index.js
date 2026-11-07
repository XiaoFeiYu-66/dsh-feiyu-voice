/**
 * dsh-feiyu-voice —— 小肥鱼语音（可移植版）
 *
 * 用本机 MOSS-TTS-Nano（ONNX CPU）+ 自备参考音色合成语音，并可通过 dsh-qqbot 发成 QQ 语音条。
 *
 * 本包不包含模型、Python 环境和任何音色文件；只依赖一个“TTS 运行目录”（ttsHome）：
 *   <ttsHome>/
 *     venv/Scripts/python.exe      （Windows；*nix 为 venv/bin/python）
 *     _src/MOSS-TTS-Nano-main/     （MOSS-TTS-Nano 源码，含 models/）
 *     refs/<名字>.wav              （你自备的参考音色）
 *     out/                         （生成结果）
 *
 * 插件自带的脚本：scripts/speakd.py（常驻合成服务）、scripts/qq-voice.py（上传语音到 QQ）。
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-feiyu-voice'
export const inject = ['tools', 'webServer']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = join(PLUGIN_DIR, 'scripts')

/** 把「属性表 + required: true」编译成标准 JSON Schema（不依赖 @deepseek-ai/dsh-tools）。 */
function compileProps(spec) {
  return fixSchema({ type: 'object', additionalProperties: false, properties: spec || {} })
}

function fixSchema(node) {
  if (Array.isArray(node)) return node.map(fixSchema)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && value === true) continue
    if (key === 'properties' && value && typeof value === 'object') {
      const props = {}
      const required = []
      for (const [propKey, propValue] of Object.entries(value)) {
        const { required: isRequired, ...rest } = propValue || {}
        props[propKey] = fixSchema(rest)
        if (isRequired) required.push(propKey)
      }
      out.properties = props
      if (required.length) out.required = required
      continue
    }
    out[key] = fixSchema(value)
  }
  return out
}

function defineTool(def) {
  return {
    ...def,
    parameters: compileProps(def.parameters || {}),
    output: { schema: fixSchema(def.output.schema), render: def.output.render },
  }
}

const DEFAULTS = {
  ttsHome: '',
  speakdUrl: 'http://127.0.0.1:18084',
  defaultRef: '',
  autoStartDaemon: true,
  daemonStartTimeoutMs: 150000,
  speakTimeoutMs: 300000,
  sendTimeoutMs: 360000,
}

const SETTINGS_FILE = join(homedir(), '.dsh', 'feiyu-voice.json')
const isWindows = platform() === 'win32'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function wavDuration(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0
    let off = 12
    let sampleRate = 0
    let channels = 0
    let bits = 16
    let dataSize = 0
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(off + 10)
        sampleRate = buf.readUInt32LE(off + 12)
        bits = buf.readUInt16LE(off + 22)
      } else if (id === 'data') {
        dataSize = size
        break
      }
      off += 8 + size + (size % 2)
    }
    if (!sampleRate || !channels) return 0
    return dataSize / (sampleRate * channels * (bits / 8))
  } catch {
    return 0
  }
}

function run(cmd, args, { timeoutMs = 300000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.stdout.on('data', (b) => {
      stdout += String(b)
    })
    child.stderr.on('data', (b) => {
      stderr += String(b)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}${String(err?.message ?? err)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) }
  try {
    mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  return next
}

function readBody(req, limit = 65536) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > limit) raw = raw.slice(0, limit)
    })
    req.on('end', () => resolve(raw))
    req.on('error', () => resolve(''))
  })
}

export function apply(ctx, config = {}) {
  const patchCfg = { ...DEFAULTS, ...(config || {}) }
  const effective = () => {
    const s = readSettings()
    const pickStr = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
    return {
      ...patchCfg,
      ttsHome: pickStr(s.ttsHome, pickStr(patchCfg.ttsHome, process.env.DSH_FEIYU_TTS_HOME || join(homedir(), '.dsh', 'tts'))),
      defaultRef: pickStr(s.defaultRef, patchCfg.defaultRef || ''),
      speakdUrl: pickStr(s.speakdUrl, patchCfg.speakdUrl),
      autoStartDaemon: typeof s.autoStartDaemon === 'boolean' ? s.autoStartDaemon : Boolean(patchCfg.autoStartDaemon),
    }
  }

  const pathsOf = (cfg) => {
    const venv = join(cfg.ttsHome, 'venv')
    return {
      home: cfg.ttsHome,
      venvPython: join(venv, isWindows ? 'Scripts/python.exe' : 'bin/python'),
      venvPythonW: join(venv, 'Scripts/pythonw.exe'),
      repo: join(cfg.ttsHome, '_src', 'MOSS-TTS-Nano-main'),
      infer: join(cfg.ttsHome, '_src', 'MOSS-TTS-Nano-main', 'infer_onnx.py'),
      out: join(cfg.ttsHome, 'out'),
      speakd: join(SCRIPTS_DIR, 'speakd.py'),
      qqVoice: join(SCRIPTS_DIR, 'qq-voice.py'),
    }
  }

  const log = (msg) => {
    try {
      ctx.logger?.info?.(`[feiyu-voice] ${msg}`)
    } catch {
      /* ignore */
    }
  }

  const urlOf = (cfg) => String(cfg.speakdUrl || DEFAULTS.speakdUrl).replace(/\/+$/, '')

  async function health(cfg = effective()) {
    try {
      const res = await fetch(`${urlOf(cfg)}/health`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  let starting = null
  async function ensureDaemon(cfg = effective(), force = false) {
    if (await health(cfg)) return true
    if (!force && !cfg.autoStartDaemon) return false
    const p = pathsOf(cfg)
    if (!existsSync(p.venvPython) || !existsSync(p.speakd)) return false
    if (starting) return starting
    starting = (async () => {
      log('speakd 未运行，自动拉起…')
      const exe = isWindows && existsSync(p.venvPythonW) ? p.venvPythonW : p.venvPython
      let fd = null
      try {
        mkdirSync(p.home, { recursive: true })
        fd = openSync(join(p.home, 'speakd-spawn.log'), 'a')
      } catch {
        fd = null
      }
      try {
        const child = spawn(exe, [p.speakd, '--tts-home', p.home, '--port', String(new URL(urlOf(cfg)).port || 18084)], {
          cwd: p.home,
          detached: true,
          stdio: fd !== null ? ['ignore', fd, fd] : 'ignore',
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        })
        child.unref()
      } catch (e) {
        log(`拉起 speakd 失败：${e?.message ?? e}`)
        return false
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd)
          } catch {
            /* ignore */
          }
        }
      }
      const deadline = Date.now() + Number(cfg.daemonStartTimeoutMs || DEFAULTS.daemonStartTimeoutMs)
      while (Date.now() < deadline) {
        await sleep(1500)
        if (await health(cfg)) return true
      }
      log('speakd 启动超时（看 speakd-spawn.log）')
      return false
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  async function stopDaemon(cfg = effective()) {
    try {
      await fetch(`${urlOf(cfg)}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    } catch {
      /* ignore */
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (!(await health(cfg))) return true
      await sleep(1000)
    }
    return false
  }

  function scanRefs(cfg) {
    const dir = join(cfg.ttsHome, 'refs')
    try {
      return readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.wav'))
        .sort()
        .map((f) => ({ name: f.replace(/\.wav$/i, ''), path: join(dir, f) }))
    } catch {
      return []
    }
  }

  function resolveRef(value, cfg = effective()) {
    const raw = String(value || cfg.defaultRef || '').trim()
    if (!raw) {
      throw new Error('还没有配置参考音色：传 ref，或在设置页里选一个 / 填一个 wav 路径')
    }
    const looksPath = /[\\/]/.test(raw) || /\.(wav|mp3|flac)$/i.test(raw)
    const path = looksPath ? raw : join(cfg.ttsHome, 'refs', `${raw}.wav`)
    if (!existsSync(path)) {
      throw new Error(`参考音色不存在：${path}（把 wav 放进 ${join(cfg.ttsHome, 'refs')}，或传绝对路径）`)
    }
    return { name: raw, path }
  }

  /** 合成语音，返回 { path, durationSec, via, elapsedSec } */
  async function synthesize(text, ref, maxFrames) {
    const cfg = effective()
    const p = pathsOf(cfg)
    const body = String(text || '').trim()
    if (!body) throw new Error('text 不能为空')
    if (body.length > 300) throw new Error(`文本 ${body.length} 字过长（建议 ≤300）`)
    const resolved = resolveRef(ref, cfg)
    mkdirSync(p.out, { recursive: true })

    if (await ensureDaemon(cfg)) {
      const started = Date.now()
      const res = await fetch(`${urlOf(cfg)}/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body, ref: resolved.path, max_frames: maxFrames || 375 }),
        signal: AbortSignal.timeout(Number(cfg.speakTimeoutMs || DEFAULTS.speakTimeoutMs)),
      })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const file = join(p.out, `feiyu-${Date.now()}.wav`)
        writeFileSync(file, buf)
        return {
          path: file,
          durationSec: Math.round(wavDuration(buf) * 100) / 100,
          via: 'daemon',
          elapsedSec: Math.round((Date.now() - started) / 100) / 10,
        }
      }
      log(`speakd /say 返回 ${res.status}，回退冷启动`)
    }

    // 冷启动：直接调 infer_onnx.py
    if (!existsSync(p.venvPython) || !existsSync(p.infer)) {
      throw new Error(`找不到 ${p.venvPython} 或 ${p.infer}（检查 ttsHome 是否指对）`)
    }
    const started = Date.now()
    const textFile = join(p.out, `text-${Date.now()}.txt`)
    const outFile = join(p.out, `feiyu-${Date.now()}.wav`)
    writeFileSync(textFile, body, 'utf8')
    try {
      const args = [
        p.infer,
        '--prompt-audio-path', resolved.path,
        '--text-file', textFile,
        '--output-audio-path', outFile,
        '--disable-wetext-processing',
        '--max-new-frames', String(maxFrames || 375),
      ]
      const out = await run(p.venvPython, args, {
        cwd: p.repo,
        timeoutMs: Number(cfg.speakTimeoutMs || DEFAULTS.speakTimeoutMs),
      })
      if (out.code !== 0 || !existsSync(outFile)) {
        throw new Error(`合成失败（exit ${out.code}）：${(out.stderr || out.stdout).slice(-600)}`)
      }
    } finally {
      try {
        unlinkSync(textFile)
      } catch {
        /* ignore */
      }
    }
    const buf = readFileSync(outFile)
    return {
      path: outFile,
      durationSec: Math.round(wavDuration(buf) * 100) / 100,
      via: 'cold',
      elapsedSec: Math.round((Date.now() - started) / 100) / 10,
    }
  }

  async function sendVoice(args) {
    const cfg = effective()
    const p = pathsOf(cfg)
    const body = String(args?.text || '').trim()
    if (!body) throw new Error('text 不能为空')
    if (!existsSync(p.venvPython) || !existsSync(p.qqVoice)) {
      throw new Error(`找不到 ${p.qqVoice} 或 venv python`)
    }
    const spoken = await synthesize(body, args?.ref)
    const cmd = [p.qqVoice, '--wav', spoken.path]
    if (args?.target) cmd.push('--target', String(args.target))
    if (args?.group) cmd.push('--group', String(args.group))
    if (args?.content) cmd.push('--content', String(args.content))
    if (args?.msgId) cmd.push('--msg-id', String(args.msgId))
    const out = await run(p.venvPython, cmd, { timeoutMs: Number(cfg.sendTimeoutMs || DEFAULTS.sendTimeoutMs) })
    const line = out.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
    let parsed = null
    try {
      parsed = JSON.parse(line)
    } catch {
      /* 下面统一报错 */
    }
    if (out.code !== 0 || !parsed?.ok) {
      const detail = (out.stderr || out.stdout || '').trim().slice(-800)
      throw new Error(`发送失败（exit ${out.code}）：${detail || '无输出'}`)
    }
    return { wav: spoken.path, sentAs: parsed.sent_as || '', messageId: parsed.message_id || '' }
  }

  let healthCache = null
  async function refreshHealth() {
    healthCache = await health(effective())
    return healthCache
  }

  function statusSnapshot() {
    const cfg = effective()
    const p = pathsOf(cfg)
    return {
      daemon: { running: Boolean(healthCache?.ok), busy: Boolean(healthCache?.busy) },
      defaultRef: String(cfg.defaultRef || ''),
      autoStartDaemon: Boolean(cfg.autoStartDaemon),
      ttsHome: cfg.ttsHome,
      speakdUrl: urlOf(cfg),
      refs: scanRefs(cfg),
      files: {
        python: existsSync(p.venvPython),
        infer: existsSync(p.infer),
        speakd: existsSync(p.speakd),
        qqVoice: existsSync(p.qqVoice),
        out: existsSync(p.out),
      },
    }
  }

  // ---------------------------- 设置页用的本地 HTTP 路由 ----------------------------
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }

  const routes = [
    {
      kind: 'exact',
      path: '/feiyu-voice/status',
      handler: async (req, res) => {
        try {
          await refreshHealth()
          sendJson(res, 200, statusSnapshot())
        } catch (e) {
          sendJson(res, 500, { error: String(e?.message ?? e) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/feiyu-voice/config',
      handler: async (req, res) => {
        try {
          const raw = await readBody(req)
          const body = raw ? JSON.parse(raw) : {}
          const patch = {}
          if (typeof body.defaultRef === 'string') patch.defaultRef = body.defaultRef.trim()
          if (typeof body.autoStartDaemon === 'boolean') patch.autoStartDaemon = body.autoStartDaemon
          if (typeof body.ttsHome === 'string' && body.ttsHome.trim()) patch.ttsHome = body.ttsHome.trim()
          saveSettings(patch)
          await refreshHealth()
          sendJson(res, 200, { ok: true, ...statusSnapshot() })
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e?.message ?? e) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/feiyu-voice/speak',
      handler: async (req, res) => {
        try {
          const raw = await readBody(req)
          const body = raw ? JSON.parse(raw) : {}
          const result = await synthesize(body.text, body.ref)
          const buf = readFileSync(result.path)
          res.writeHead(200, {
            'content-type': 'audio/wav',
            'cache-control': 'no-store',
            'content-length': String(buf.length),
            'X-Duration': String(result.durationSec),
            'X-Elapsed': String(result.elapsedSec),
            'X-Via': String(result.via),
          })
          res.end(buf)
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/feiyu-voice/daemon',
      handler: async (req, res) => {
        try {
          const raw = await readBody(req)
          const body = raw ? JSON.parse(raw) : {}
          const action = String(body.action || '')
          if (action === 'start') {
            const ok = await ensureDaemon(effective(), true)
            await refreshHealth()
            sendJson(res, 200, { ok, ...statusSnapshot() })
          } else if (action === 'stop') {
            const ok = await stopDaemon(effective())
            await refreshHealth()
            sendJson(res, 200, { ok, ...statusSnapshot() })
          } else {
            sendJson(res, 400, { ok: false, error: 'action 只能是 start 或 stop' })
          }
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
        }
      },
    },
  ]

  const routeDisposers = routes.map((route) => ctx.effect(() => ctx.webServer.register(route)))

  // ---------------------------- 工具 ----------------------------
  const speakTool = defineTool({
    name: 'feiyu_speak',
    description:
      '用本机 MOSS-TTS-Nano 合成语音并保存为 wav。需要先在设置里指定参考音色（refs 目录下的 wav），或直接传 ref。优先走常驻服务（约 20–40 秒），服务没起会自动拉起，失败再冷启动（约 1–2 分钟）。',
    parameters: {
      text: { type: 'string', required: true, description: '要说的文本，口语化、建议 ≤150 字' },
      ref: { type: 'string', description: '参考音色：ttsHome/refs 下的名字（不带 .wav）或 wav 绝对路径；不传用设置里的默认音色' },
      maxFrames: { type: 'integer', description: '最大音频帧数，默认 375；文本偏长可适当加大' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          durationSec: { type: 'number', required: true },
          via: { type: 'string', required: true },
          elapsedSec: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已生成 ${value.durationSec}s 语音（${value.via}，耗时 ${value.elapsedSec}s）：${value.path}` },
      ],
    },
    async execute(args) {
      return await synthesize(args?.text, args?.ref, args?.maxFrames)
    },
  })

  const sendTool = defineTool({
    name: 'feiyu_send_voice',
    description:
      '合成语音并通过 dsh-qqbot 的机器人账号发成 QQ 语音条。默认发到 qqbot 白名单里的第一个 c2c 用户；可传 target/group 指定。',
    parameters: {
      text: { type: 'string', required: true, description: '要说的文本，口语化、建议 ≤30 字' },
      ref: { type: 'string', description: '参考音色：refs 下的名字或 wav 绝对路径；不传用默认音色' },
      target: { type: 'string', description: '发送目标，形如 c2c:<openid>；不填用白名单第一个' },
      group: { type: 'string', description: '群 openid（与 target 二选一）' },
      content: { type: 'string', description: '可选附带的文字' },
      msgId: { type: 'string', description: '被动回复的消息 id；填了不占 QQ 主动消息额度' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
          wav: { type: 'string', required: true },
          sentAs: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已发送 QQ 语音 ✓ message_id=${value.messageId || '(无)'}\n本地文件：${value.wav}` },
      ],
    },
    async execute(args) {
      return await sendVoice(args)
    },
  })

  const statusTool = defineTool({
    name: 'feiyu_voice_status',
    description: '查看小肥鱼语音的就绪状态：常驻服务、ttsHome、已发现的参考音色、依赖文件是否齐全。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          daemon: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: { running: { type: 'boolean', required: true }, busy: { type: 'boolean', required: true } },
          },
          defaultRef: { type: 'string', required: true },
          ttsHome: { type: 'string', required: true },
          refs: { type: 'array', required: true, items: { type: 'string' } },
          files: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              python: { type: 'boolean', required: true },
              infer: { type: 'boolean', required: true },
              speakd: { type: 'boolean', required: true },
              qqVoice: { type: 'boolean', required: true },
              out: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `常驻服务：${value.daemon.running ? '运行中' : '未运行'}${value.daemon.busy ? '（忙）' : ''}`,
            `ttsHome：${value.ttsHome}`,
            `默认音色：${value.defaultRef || '(未设置)'}　可用音色：${value.refs.length ? value.refs.join(', ') : '(refs 目录为空)'}`,
            `依赖：python=${value.files.python} infer=${value.files.infer} speakd=${value.files.speakd} qq-voice=${value.files.qqVoice} out=${value.files.out}`,
          ].join('\n'),
        },
      ],
    },
    async execute() {
      await refreshHealth()
      const s = statusSnapshot()
      return {
        daemon: s.daemon,
        defaultRef: s.defaultRef,
        ttsHome: s.ttsHome,
        refs: s.refs.map((r) => r.name),
        files: s.files,
      }
    },
  })

  const toolDisposers = [speakTool, sendTool, statusTool].map((tool) => ctx.tools.register(tool))
  log(`已注册 3 个工具 + ${routes.length} 条设置页路由`)
  return () => {
    for (const dispose of [...toolDisposers, ...routeDisposers].reverse()) {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
  }
}
