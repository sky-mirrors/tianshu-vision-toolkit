/**
 * 视觉模型客户端：三种协议的请求构造、响应取文本、有限重试与密钥脱敏。
 *
 * 语义对齐上游 `vision_client.py`：chat_completions / responses / anthropic 三选一，
 * 图像一律走 data URL；429/500/502/503/504/529 可重试（每日限额类错误不重试），
 * 错误消息里的密钥替换成 `<redacted>`。
 */

const DEFAULT_PROMPT = 'Please describe the contents of this image in detail.'
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])
const NON_RETRYABLE_CODES = new Set(['daily_rate_limit_exceeded', 'global_daily_limit_exceeded', 'rate_limit_exceeded'])
const MAX_RETRIES = 2

export function redact(text, secret) {
  return secret ? String(text).split(secret).join('<redacted>') : String(text)
}

/** 组装请求：{ url, headers, body }。协议差异全部收敛在这里。 */
export function buildRequest(config, imageUrls, prompt, maxTokens) {
  const text = prompt ?? DEFAULT_PROMPT
  const headers = { 'Content-Type': 'application/json', 'User-Agent': config.userAgent ?? DEFAULT_USER_AGENT }
  let endpoint
  let body

  if (config.protocol === 'responses') {
    endpoint = '/responses'
    body = {
      model: config.model,
      store: false,
      input: [{
        role: 'user',
        content: [
          ...imageUrls.map(url => ({ type: 'input_image', image_url: url })),
          { type: 'input_text', text },
        ],
      }],
    }
    if (maxTokens !== undefined) body.max_output_tokens = maxTokens
    if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort }
  } else if (config.protocol === 'anthropic') {
    endpoint = '/messages'
    body = {
      model: config.model,
      max_tokens: maxTokens ?? 4096,
      messages: [{
        role: 'user',
        content: [
          ...imageUrls.map(url => ({ type: 'image', source: anthropicImageSource(url) })),
          { type: 'text', text },
        ],
      }],
    }
    if (config.anthropicThinking !== 'omit') {
      if (!['disabled', 'adaptive'].includes(config.anthropicThinking)) {
        throw new Error('unsupported VISION_ANTHROPIC_THINKING; use omit, disabled or adaptive')
      }
      body.thinking = { type: config.anthropicThinking }
    }
  } else {
    endpoint = '/chat/completions'
    body = {
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
          { type: 'text', text },
        ],
      }],
    }
    if (maxTokens !== undefined) body.max_tokens = maxTokens
  }

  if (config.protocol === 'anthropic') {
    headers['x-api-key'] = config.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`
  }

  return { url: `${config.baseUrl}${endpoint}`, headers, body }
}

function anthropicImageSource(url) {
  if (!url.startsWith('data:')) return { type: 'url', url }
  const marker = ';base64,'
  const index = url.indexOf(marker)
  if (!url.startsWith('data:') || index < 0) {
    throw new Error('anthropic image data URLs must use base64 encoding')
  }
  const mediaType = url.slice(5, index)
  if (!mediaType) throw new Error('anthropic image data URLs must include a media type')
  return { type: 'base64', media_type: mediaType, data: url.slice(index + marker.length) }
}

/** 从各协议的响应结构里取出文本。 */
export function extractText(protocol, payload) {
  if (protocol === 'responses') {
    const output = payload?.output
    if (!Array.isArray(output)) return ''
    return output
      .filter(item => item?.type === 'message' && Array.isArray(item.content))
      .flatMap(item => item.content)
      .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
      .trim()
  }
  if (protocol === 'anthropic') {
    const content = payload?.content
    if (!Array.isArray(content)) return ''
    return content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
  }
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n').trim()
  }
  return ''
}

function errorCode(bodyText) {
  try {
    const parsed = JSON.parse(bodyText)
    const code = parsed?.error?.code
    return typeof code === 'string' ? code : ''
  } catch {
    return ''
  }
}

function retryDelayMs(response, attempt) {
  const header = response?.headers?.get?.('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds, 60)) * 1000
    const at = Date.parse(header)
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 60000))
  }
  return Math.min(2 ** attempt, 4) * 1000
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 调用视觉模型并返回文本。失败时抛出带脱敏上下文的错误。
 * @param {object} config resolveVisionConfig() 的产物
 * @param {string[]} imageUrls data URL 或 http(s) URL
 * @param {{ prompt?: string, maxTokens?: number, fetchImpl?: typeof fetch, retryDelay?: (ms:number)=>Promise<void>,
 *           signal?: AbortSignal }} options
 */
export async function describeImages(config, imageUrls, options = {}) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) throw new Error('no image was provided')
  for (const url of imageUrls) {
    if (!url.startsWith('data:') && !url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error('only data URLs or http(s) image URLs are supported')
    }
  }

  const request = buildRequest(config, imageUrls, options.prompt, options.maxTokens)
  const fetchImpl = options.fetchImpl ?? config.fetchImpl ?? fetch
  const wait = options.retryDelay ?? sleep

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response
    try {
      response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        // 调用方的 timeoutMs 要在**请求层**生效，否则上层只是 reject，请求仍在飞。
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('vision API request aborted')
      if (attempt < MAX_RETRIES) {
        await wait(Math.min(2 ** attempt, 4) * 1000)
        continue
      }
      throw new Error(`vision API network error: ${redact(error.message, config.apiKey)}`)
    }

    if (!response.ok) {
      const bodyText = redact((await response.text()).slice(0, 400), config.apiKey).replace(/\s+/g, ' ')
      const retryable = RETRYABLE_STATUS.has(response.status) && !NON_RETRYABLE_CODES.has(errorCode(bodyText))
      if (retryable && attempt < MAX_RETRIES) {
        await wait(retryDelayMs(response, attempt))
        continue
      }
      throw new Error(`vision API HTTP ${response.status}: ${bodyText}`)
    }

    const payload = await response.json()
    const text = extractText(config.protocol, payload)
    if (!text) throw new Error('vision API returned an empty description')
    return text
  }
  throw new Error('vision API request failed')
}

/** 本地图像文件 → data URL（只放行 PNG/JPEG/GIF/WebP）。 */
export function fileToDataUrl(bytes, mimeType) {
  const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  if (!allowed.has(mimeType)) {
    throw new Error(`unsupported image type ${mimeType}; only PNG, JPEG, GIF and WebP are accepted`)
  }
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}

/** 按文件头判 MIME，避免扩展名撒谎。 */
export function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.toString('latin1', 0, 3) === 'GIF') return 'image/gif'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}
