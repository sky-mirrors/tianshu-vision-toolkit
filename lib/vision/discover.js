/**
 * 从**天枢自己的** provider 配置里发现可用的视觉端点，让用户不必再手填一套 VISION_*。
 *
 * 数据来源与可靠性：
 * - `<rivetHome>/config.json` 的 `provider.providers[*].models[*].supportsVision`：可读、可信；
 *   这是用户已经配好的模型，用它等于复用天枢既有能力。
 * - `<rivetHome>/provider-keys.json`：实测值是 Uint8Array 形态的加密块，插件读不懂，
 *   所以这里**不去解密**，只按 `apiKeyEnv` 去 `process.env` 取。
 *
 * 若推导不出 rivetHome（比如宿主没给 storage），返回 null，调用方回落到环境变量/config.json。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 把天枢的 provider protocol 映射到本插件支持的三种之一。 */
const PROTOCOL_MAP = { openai: 'chat_completions', anthropic: 'anthropic', responses: 'responses' }

/**
 * plugin-data/<pluginId>/ → rivetHome（storage 的目录约定，两级上跳）。
 * @param {string | undefined} dataDir host.storage.dataDir() 的返回值
 */
export function rivetHomeFromDataDir(dataDir) {
  if (!dataDir) return undefined
  return dirname(dirname(dataDir))
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error(`cannot read ${path}: ${error.message}`)
  }
}

/**
 * 扫描天枢 provider 配置，返回第一个「配了视觉模型且取得到密钥」的候选。
 * @param {{ dataDir?: string, env?: Record<string,string|undefined> }} options
 * @returns {{ baseUrl:string, apiKey:string, model:string, protocol:string,
 *             providerId:string, from:string } | null}
 */
export function discoverTianshuVisionProvider(options = {}) {
  const env = options.env ?? process.env
  const home = rivetHomeFromDataDir(options.dataDir)
  if (!home) return null

  const config = readJson(join(home, 'config.json'))
  const providers = config?.provider?.providers
  if (!providers || typeof providers !== 'object') return null

  // 按配置里出现的顺序遍历：用户排在前面的 provider 视为更常用。
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || !Array.isArray(provider.models)) continue
    const visionModel = provider.models.find(model => model?.supportsVision === true)
    if (!visionModel) continue

    const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : ''
    if (baseUrl === '') continue

    const keyEnv = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : ''
    const apiKey = keyEnv ? (env[keyEnv] ?? '').trim() : ''
    if (apiKey === '') continue

    const protocol = PROTOCOL_MAP[provider.protocol] ?? 'chat_completions'
    return {
      baseUrl,
      apiKey,
      model: visionModel.id,
      protocol,
      providerId,
      from: `Tianshu provider "${providerId}" (model ${visionModel.id})`,
    }
  }
  return null
}

/** 给用户看的候选清单：哪些 provider 配了视觉模型、还差什么。 */
export function listVisionCandidates(options = {}) {
  const env = options.env ?? process.env
  const home = rivetHomeFromDataDir(options.dataDir)
  if (!home) return []
  const config = readJson(join(home, 'config.json'))
  const providers = config?.provider?.providers
  if (!providers || typeof providers !== 'object') return []

  const rows = []
  for (const [providerId, provider] of Object.entries(providers)) {
    const visionModel = Array.isArray(provider?.models)
      ? provider.models.find(model => model?.supportsVision === true)
      : undefined
    if (!visionModel) continue
    const keyEnv = typeof provider?.apiKeyEnv === 'string' ? provider.apiKeyEnv : ''
    rows.push({
      providerId,
      model: visionModel.id,
      hasBaseUrl: typeof provider?.baseUrl === 'string' && provider.baseUrl.trim() !== '',
      keyEnv,
      hasKey: keyEnv !== '' && (env[keyEnv] ?? '').trim() !== '',
    })
  }
  return rows
}
