/**
 * 视觉模型配置：环境变量优先，其次插件数据目录下的 config.json。
 *
 * 字段与上游 `vision_client.py` 同名同义（VISION_BASE_URL / VISION_API_KEY /
 * VISION_MODEL / VISION_API_PROTOCOL）。配置在每次调用时读取，改配置无需重启。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverTianshuVisionProvider, listVisionCandidates } from './discover.js'

const PROTOCOLS = new Set(['chat_completions', 'responses', 'anthropic'])

/**
 * 读配置文件。目录没有配置视为「未配置」（回落到环境变量）；文件存在但坏了要报错，
 * 不能静默当成未配置——那会让用户以为在用自己的端点，实际在打别人的。
 */
function readConfigFile(dataDir) {
  if (!dataDir) return {}
  const path = join(dataDir, 'config.json')
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`vision config at ${path} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`vision config at ${path} must be a JSON object`)
  }
  return parsed
}

/**
 * 解析视觉配置。优先级：环境变量 / 插件 config.json → 天枢自己的 provider 配置。
 * 都没有才报错，且错误里列出「天枢里哪些 provider 配了视觉模型、还差什么」。
 * @param {{ dataDir?: string, env?: Record<string, string|undefined> }} options
 */
export function resolveVisionConfig(options = {}) {
  const env = options.env ?? process.env
  const file = readConfigFile(options.dataDir)

  const pick = (envName, fileKey) => {
    const fromEnv = env[envName]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
    const fromFile = file[fileKey]
    if (typeof fromFile === 'string' && fromFile.trim() !== '') return fromFile.trim()
    return undefined
  }

  const baseUrlRaw = pick('VISION_BASE_URL', 'baseUrl')
  const apiKeyRaw = pick('VISION_API_KEY', 'apiKey')
  const modelRaw = pick('VISION_MODEL', 'model')

  // 缺哪项就由天枢 provider 补哪项：密钥始终只能来自显式配置或环境变量（天枢的密钥库是加密的）。
  const discovered = (baseUrlRaw === undefined || apiKeyRaw === undefined || modelRaw === undefined)
    ? discoverTianshuVisionProvider(options)
    : null
  const baseUrl = baseUrlRaw ?? discovered?.baseUrl
  const apiKey = apiKeyRaw ?? discovered?.apiKey
  const model = modelRaw ?? discovered?.model

  const missing = [
    ['VISION_BASE_URL', baseUrl],
    ['VISION_API_KEY', apiKey],
    ['VISION_MODEL', model],
  ].filter(([, value]) => value === undefined).map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(buildMissingMessage(missing, listVisionCandidates(options)))
  }

  const protocol = (pick('VISION_API_PROTOCOL', 'protocol') ?? discovered?.protocol ?? 'chat_completions').toLowerCase()
  if (!PROTOCOLS.has(protocol)) {
    throw new Error(`unsupported VISION_API_PROTOCOL ${protocol}; use chat_completions, responses or anthropic`)
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    protocol,
    userAgent: pick('VISION_USER_AGENT', 'userAgent'),
    reasoningEffort: pick('VISION_REASONING_EFFORT', 'reasoningEffort'),
    anthropicThinking: (pick('VISION_ANTHROPIC_THINKING', 'anthropicThinking') ?? 'omit').toLowerCase(),
    sslVerify: !['0', 'false', 'off', 'no', 'none', 'disabled'].includes(
      (pick('VISION_SSL_VERIFY', 'sslVerify') ?? '').toLowerCase(),
    ),
    source: discovered !== null && (baseUrlRaw === undefined || modelRaw === undefined)
      ? `${discovered.from}${apiKeyRaw === undefined ? ' + apiKey from env' : ''}`
      : 'env/config.json',
  }
}

/** 缺配置时的错误：既要指出怎么直配，也要指出天枢里现成可用的视觉 provider 缺什么。 */
function buildMissingMessage(missing, candidates) {
  const lines = [
    `missing vision config ${missing.join(', ')}`,
    'two ways to fix it:',
    '  1) set the environment variables (VISION_BASE_URL / VISION_API_KEY / VISION_MODEL), or write them into <plugin-data-dir>/config.json',
  ]
  if (candidates.length > 0) {
    lines.push('  2) reuse a Tianshu provider that already declares a vision model:')
    for (const row of candidates) {
      const lacks = []
      if (!row.hasBaseUrl) lacks.push('baseUrl')
      if (!row.hasKey) lacks.push(`env ${row.keyEnv === '' ? '(no apiKeyEnv declared)' : row.keyEnv}`)
      lines.push(`     - ${row.providerId} / ${row.model}${lacks.length === 0 ? ' (ready)' : ` (needs ${lacks.join(' + ')})`}`)
    }
  }
  return lines.join('\n')
}
