/**
 * 视觉链路的契约测试：请求载荷、响应取文本、重试、脱敏、定位解析、长截图合并。
 *
 * 全部用桩 fetch，不联网——这里验证的是协议形状与错误处理语义，不是模型回答质量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureHtml, fixtureImage } from './fixtures.mjs'
import { buildRequest, describeImages, extractText, redact, sniffMime, fileToDataUrl } from '../lib/vision/client.js'
import { resolveVisionConfig } from '../lib/vision/config.js'
import { buildLocatePrompt, buildCategoryTarget, coordinateOrder, extractLocateItems, normalizeBox, parseMatches, positionOf } from '../lib/tools/location.js'
import { mergeChunkTexts, planChunks, rowEnergy, resolveSplitSizes, chooseCut } from '../lib/tools/long-ocr.js'
import { connectedComponents } from '../lib/tools/extract-fg.js'

const baseConfig = {
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-secret-key',
  model: 'vision-model',
  protocol: 'chat_completions',
  anthropicThinking: 'omit',
}

test('resolveVisionConfig 缺必填项时报错并点名缺哪个', () => {
  assert.throws(
    () => resolveVisionConfig({ env: { VISION_API_KEY: 'k' } }),
    /missing vision config VISION_BASE_URL, VISION_MODEL/,
  )
})

test('resolveVisionConfig 环境变量优先于文件，且校��协议白名单', () => {
  const config = resolveVisionConfig({
    env: { VISION_BASE_URL: 'https://a.example', VISION_API_KEY: 'k', VISION_MODEL: 'm', VISION_API_PROTOCOL: 'responses' },
  })
  assert.equal(config.protocol, 'responses')
  assert.equal(config.baseUrl, 'https://a.example')
  assert.throws(
    () => resolveVisionConfig({ env: { VISION_BASE_URL: 'x', VISION_API_KEY: 'k', VISION_MODEL: 'm', VISION_API_PROTOCOL: 'grpc' } }),
    /unsupported VISION_API_PROTOCOL/,
  )
})

test('chat_completions 载荷把图像放在 text 之前', () => {
  const request = buildRequest(baseConfig, ['data:image/png;base64,AAA'], 'look here')
  assert.equal(request.url, 'https://api.example.com/chat/completions')
  assert.equal(request.headers.Authorization, 'Bearer sk-secret-key')
  const content = request.body.messages[0].content
  assert.equal(content[0].type, 'image_url')
  assert.equal(content[0].image_url.url, 'data:image/png;base64,AAA')
  assert.equal(content[1].type, 'text')
  assert.equal(content[1].text, 'look here')
})

test('responses 载荷使用 input_image 与 max_output_tokens', () => {
  const request = buildRequest({ ...baseConfig, protocol: 'responses', reasoningEffort: 'low' },
    ['data:image/png;base64,AAA'], 'q', 128)
  assert.equal(request.url, 'https://api.example.com/responses')
  assert.equal(request.body.input[0].content[0].type, 'input_image')
  assert.equal(request.body.max_output_tokens, 128)
  assert.deepEqual(request.body.reasoning, { effort: 'low' })
  assert.equal(request.body.store, false)
})

test('anthropic 载荷使用 base64 图像源与 x-api-key 头', () => {
  const request = buildRequest({ ...baseConfig, protocol: 'anthropic' }, ['data:image/png;base64,AAA'], 'q', 256)
  assert.equal(request.url, 'https://api.example.com/messages')
  assert.equal(request.headers['x-api-key'], 'sk-secret-key')
  assert.equal(request.headers['anthropic-version'], '2023-06-01')
  assert.equal(request.body.messages[0].content[0].source.type, 'base64')
  assert.equal(request.body.messages[0].content[0].source.media_type, 'image/png')
  assert.equal(request.body.max_tokens, 256)
})

test('anthropic 拒绝非 base64 的 data URL', () => {
  assert.throws(
    () => buildRequest({ ...baseConfig, protocol: 'anthropic' }, ['data:image/png,raw'], 'q'),
    /must use base64 encoding/,
  )
})

test('三种协议的响应取文本', () => {
  assert.equal(extractText('chat_completions', { choices: [{ message: { content: 'desc' } }] }), 'desc')
  assert.equal(extractText('chat_completions', { choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'a\nb')
  assert.equal(extractText('responses', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'r' }] }] }), 'r')
  assert.equal(extractText('anthropic', { content: [{ type: 'text', text: 'x' }, { type: 'tool_use' }] }), 'x')
  assert.equal(extractText('chat_completions', {}), '')
})

test('describeImages 在 500 后重试并在第二次成功', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) return { ok: false, status: 500, text: async () => 'boom', headers: { get: () => null } }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
  }
  const text = await describeImages(baseConfig, ['data:image/png;base64,AAA'], { fetchImpl, retryDelay: async () => {} })
  assert.equal(text, 'ok')
  assert.equal(calls, 2)
})

test('每日限额类错误不重试，且错误消息脱敏密钥', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return {
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { code: 'daily_rate_limit_exceeded', message: 'key sk-secret-key' } }),
      headers: { get: () => '1' },
    }
  }
  await assert.rejects(
    () => describeImages(baseConfig, ['data:image/png;base64,AAA'], { fetchImpl, retryDelay: async () => {} }),
    error => {
      assert.match(error.message, /HTTP 429/)
      assert.ok(!error.message.includes('sk-secret-key'), '密钥必须被脱敏')
      assert.match(error.message, /<redacted>/)
      return true
    },
  )
  assert.equal(calls, 1)
})

test('重试耗尽后抛出最终错误', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'down', headers: { get: () => null } })
  await assert.rejects(
    () => describeImages(baseConfig, ['data:image/png;base64,AAA'], { fetchImpl, retryDelay: async () => {} }),
    /HTTP 503/,
  )
})

test('空回答当作失败而不是空描述', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '  ' } }] }) })
  await assert.rejects(
    () => describeImages(baseConfig, ['data:image/png;base64,AAA'], { fetchImpl }),
    /empty description/,
  )
})

test('redact 与 MIME 嗅探', () => {
  assert.equal(redact('has sk-secret-key inside', 'sk-secret-key'), 'has <redacted> inside')
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg')
  assert.equal(sniffMime(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(sniffMime(Buffer.from('nope')), undefined)
  assert.throws(() => fileToDataUrl(Buffer.from('x'), 'image/tiff'), /unsupported image type/)
})

test('定位提示词按 box 顺序切换坐标说明', () => {
  assert.match(buildLocatePrompt('the button', 'xyxy'), /\[x0, y0, x1, y1\]/)
  assert.match(buildLocatePrompt('the button', 'yxyx'), /\[y0, x0, y1, x1\]/)
  assert.equal(coordinateOrder({}, 'Qwen-VL'), 'xyxy')
  assert.equal(coordinateOrder({}, 'gpt-4o'), 'yxyx')
  assert.throws(() => coordinateOrder({ VISION_BOX_ORDER: 'abcd' }, 'x'), /must be either xyxy or yxyx/)
})

test('detect 的 target 自动补全类别语义', () => {
  const target = buildCategoryTarget('buttons')
  assert.match(target, /^every distinct buttons/)
  assert.match(target, /exact visible text/)
  assert.match(buildCategoryTarget(undefined), /UI element/)
})

test('0-1000 网格按两种顺序换算，越界与反向都被处理', () => {
  const yxyx = normalizeBox({ box_2d: [500, 0, 1000, 500] }, 200, 100, 'yxyx')
  assert.deepEqual(yxyx, { x1: 0, y1: 50, x2: 100, y2: 100 })
  const xyxy = normalizeBox({ box_2d: [900, 0, 0, 200] }, 100, 100, 'xyxy')
  assert.deepEqual(xyxy, { x1: 0, y1: 0, x2: 90, y2: 20 })
  assert.equal(normalizeBox({ box_2d: [10, 10, 10, 10] }, 100, 100, 'xyxy'), null)
  assert.equal(normalizeBox({ box_2d: 'bad' }, 100, 100), null)
})

test('定位回包支持围栏、键名变体与正则兜底', () => {
  const fenced = '```json\n[{"box_2d": [0, 0, 500, 500], "label": "a"}]\n```'
  assert.equal(extractLocateItems(fenced).length, 1)
  const wrapped = '{"boxes": [{"box_2d": [0, 0, 500, 500]}]}'
  assert.equal(extractLocateItems(wrapped).length, 1)
  const fallback = 'noise {"box_2d": [10, 20, 30, 40], "label": "b"} trailing'
  assert.equal(extractLocateItems(fallback).length, 1)
  assert.throws(() => extractLocateItems('[{"box_2d": [0, 0, 5'), /truncated or incomplete/)
  assert.throws(() => extractLocateItems('nothing here'), /parseable bounding-box JSON/)
})

test('parseMatches 丢弃非法框并保留标签', () => {
  const matches = parseMatches('[{"box_2d":[0,0,1000,1000],"label":"center"},{"box_2d":[0,0,0,0]}]', 10, 10, 'target')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].label, 'center')
  assert.deepEqual(matches[0].box, { x1: 0, y1: 0, x2: 10, y2: 10 })
})

test('positionOf 按三分之一网格给方位', () => {
  assert.equal(positionOf({ x1: 0, y1: 0, x2: 30, y2: 30 }, 300, 300), 'top-left')
  assert.equal(positionOf({ x1: 135, y1: 135, x2: 165, y2: 165 }, 300, 300), 'center')
  assert.equal(positionOf({ x1: 240, y1: 240, x2: 300, y2: 300 }, 300, 300), 'bottom-right')
})

test('长截图切块参数校验 overlap 上限', () => {
  const sizes = resolveSplitSizes({ mode: 'general', targetHeight: 400, minHeight: 200, maxHeight: 600, overlap: 40 }, 2000)
  assert.equal(sizes.target, 400)
  assert.throws(() => resolveSplitSizes({ minHeight: 100, overlap: 60 }, 2000), /less than half of min-height/)
  assert.throws(() => resolveSplitSizes({ maxHeight: 100, minHeight: 200 }, 2000), /maxHeight must be >= minHeight/)
})

test('切点在空白行处选出，块计划覆盖整幅且首尾不重叠', () => {
  const energy = new Float64Array(1000).fill(50)
  for (let y = 0; y < 1000; y += 50) energy[y] = 0
  const cut = chooseCut(energy, 0, 200, 600)
  assert.ok(cut % 50 === 0 || cut === 1000, `切点应落在低能量行，实际 ${cut}`)
  const chunks = planChunks(1000, { target: 400, minimum: 200, maximum: 600, overlap: 40, energy })
  assert.equal(chunks[0].cropTop, 0)
  assert.equal(chunks[chunks.length - 1].cropBottom, 1000)
  assert.ok(chunks.every((chunk, i) => i === 0 || chunk.coreTop === chunks[i - 1].coreBottom))
})

test('rowEnergy 在纯色图上为零、在文字状条纹上更高', () => {
  const flat = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 3).fill(100) }
  assert.ok(Math.max(...rowEnergy(flat)) <= 1)
  const striped = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 3) }
  for (let i = 0; i < striped.data.length; i += 1) striped.data[i] = i % 8 < 4 ? 0 : 255
  assert.ok(Math.max(...rowEnergy(striped)) > 50)
})

test('分块文本合并只去掉真实重叠行', () => {
  const merged = mergeChunkTexts(['第一行\n第二行\n第三行', '第三行\n第四行'])
  assert.equal(merged, '第一行\n第二行\n第三行\n第四行')
  const noOverlap = mergeChunkTexts(['甲', '乙'])
  assert.equal(noOverlap, '甲\n乙')
})

test('连通分量统计大小并按降序返回', () => {
  const ink = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 5 }]
  const components = connectedComponents(ink, 8, 8)
  assert.equal(components.length, 2)
  assert.equal(components[0].size, 2)
  assert.equal(components[1].size, 1)
})

test('配置文件缺失时回落到环境变量，损坏时报错而不是静默当未配置', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'vision-config-'))

  const missing = resolveVisionConfig({ dataDir: dir, env: { VISION_BASE_URL: 'https://a', VISION_API_KEY: 'k', VISION_MODEL: 'm' } })
  assert.equal(missing.baseUrl, 'https://a')

  writeFileSync(join(dir, 'config.json'), '{ broken')
  assert.throws(() => resolveVisionConfig({ dataDir: dir, env: {} }), /is not valid JSON/)

  writeFileSync(join(dir, 'config.json'), '["array"]')
  assert.throws(() => resolveVisionConfig({ dataDir: dir, env: {} }), /must be a JSON object/)

  writeFileSync(join(dir, 'config.json'), JSON.stringify({ baseUrl: 'https://b', apiKey: 'k2', model: 'm2' }))
  const fromFile = resolveVisionConfig({ dataDir: dir, env: {} })
  assert.equal(fromFile.baseUrl, 'https://b')
  assert.equal(fromFile.model, 'm2')

  rmSync(dir, { recursive: true, force: true })
})

test('vision_glance 拒绝空图集、query 与 ocr 互斥、region 多图', async () => {
  const { createGlanceTool } = await import('../lib/tools/glance.js')
  const tool = createGlanceTool(() => ({ baseUrl: 'https://x', apiKey: 'k', model: 'm', protocol: 'chat_completions', anthropicThinking: 'omit' }))
  const run = args => tool.execute({ args, cwd: process.cwd() })

  const empty = await run({ images: [] })
  assert.equal(empty.isError, true)
  assert.match(empty.content, /at least one image/)

  const both = await run({ images: [fixtureImage()], query: 'q', ocr: true })
  assert.equal(both.isError, true)
  assert.match(both.content, /mutually exclusive/)

  const multi = await run({ images: [fixtureImage(), fixtureImage()], region: '0,0,10,10' })
  assert.equal(multi.isError, true)
  assert.match(multi.content, /exactly one image/)
})

test('vision_ground 拒绝空 target', async () => {
  const { createGroundTool } = await import('../lib/tools/ground.js')
  const tool = createGroundTool(() => ({ baseUrl: 'https://x', apiKey: 'k', model: 'm', protocol: 'chat_completions', anthropicThinking: 'omit' }))
  const result = await tool.execute({ args: { image: fixtureImage(), target: '   ' }, cwd: process.cwd() })
  assert.equal(result.isError, true)
  assert.match(result.content, /target must not be empty/)
})

test('vision_html_screenshot 边界：非 HTML、越界尺寸、非 png 输出、文件不存在', async () => {
  const { createHtmlScreenshotTool } = await import('../lib/tools/html-screenshot.js')
  const tool = createHtmlScreenshotTool()
  const run = args => tool.execute({ args, cwd: process.cwd() })

  const wrongExt = await run({ source: `${fixtureHtml()}x` })
  assert.equal(wrongExt.isError, true)
  assert.match(wrongExt.content, /local \.html or \.htm/)

  const missing = await run({ source: 'nope.html' })
  assert.equal(missing.isError, true)
  assert.match(missing.content, /file not found/)

  for (const size of [{ width: 63 }, { width: 4097 }, { height: 63 }, { height: 4097 }, { waitMs: -1 }, { waitMs: 30001 }]) {
    const result = await run({ source: fixtureHtml(), ...size })
    assert.equal(result.isError, true, `${JSON.stringify(size)} 应被拒绝`)
  }

  const wrongOut = await run({ source: fixtureHtml(), output: 'out.jpg' })
  assert.equal(wrongOut.isError, true)
  assert.match(wrongOut.content, /must end with \.png/)
})

test('vision_extract_foreground 在无墨迹的区域报错，在纯色区域给出单分量', async () => {
  const { createExtractForegroundTool } = await import('../lib/tools/extract-fg.js')
  const { encodePng } = await import('../lib/png.js')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'fg-edge-'))

  const grey = new Uint8ClampedArray(16 * 16 * 4)
  for (let i = 0; i < 16 * 16; i += 1) { grey[i * 4] = 200; grey[i * 4 + 1] = 200; grey[i * 4 + 2] = 200; grey[i * 4 + 3] = 255 }
  const path = join(dir, 'flat.png')
  writeFileSync(path, encodePng({ width: 16, height: 16, data: grey }))

  const tool = createExtractForegroundTool()
  const none = await tool.execute({ args: { image: path, region: '0,0,16,16' }, cwd: dir })
  assert.equal(none.isError, true)
  assert.match(none.content, /no foreground pixels/)

  const sat = await tool.execute({ args: { image: path, region: '0,0,16,16', mode: 'dark', dark: 255 }, cwd: dir })
  assert.ok(!sat.isError, '成功调用不应带 isError')
  assert.equal(JSON.parse(sat.content).components, 1)

  const badRegion = await tool.execute({ args: { image: path, region: '9,9,1,1' }, cwd: dir })
  assert.equal(badRegion.isError, true)
  rmSync(dir, { recursive: true, force: true })
})

test('读图前拦截凭据类文件名', async () => {
  const { assertReadableImagePath } = await import('../lib/path-guard.js')
  assert.throws(() => assertReadableImagePath('.env'), /credential-like files/)
  assert.throws(() => assertReadableImagePath('creds/.env.local'), /credential-like files/)
  assert.throws(() => assertReadableImagePath('server.key'), /credential-like files/)
  assert.throws(() => assertReadableImagePath('id_rsa'), /credential-like files/)
  assert.throws(() => assertReadableImagePath(''), /non-empty string/)
  assert.equal(assertReadableImagePath('shot.png'), 'shot.png')
})

test('vision_glance 在 images 数组里拒绝凭据类路径', async () => {
  const { createGlanceTool } = await import('../lib/tools/glance.js')
  const tool = createGlanceTool(() => ({ baseUrl: 'https://x', apiKey: 'k', model: 'm', protocol: 'chat_completions', anthropicThinking: 'omit' }))
  await assert.rejects(
    () => tool.execute({ args: { images: ['.env'] }, cwd: process.cwd() }),
    /credential-like files/,
  )
})

test('abort 信号会让请求层真的中断，而不是只 reject 上层', async () => {
  const { describeImages } = await import('../lib/vision/client.js')
  const config = {
    baseUrl: 'https://x', apiKey: 'k', model: 'm', protocol: 'chat_completions', anthropicThinking: 'omit',
    fetchImpl: (url, init) => new Promise((_, reject) => {
      // 模拟真实 fetch：收到 abort 才结束
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(
    () => describeImages(config, ['data:image/png;base64,AAA'], { signal: controller.signal }),
    /aborted/,
  )
})

test('没有 abort 时正常返回，signal 不会误伤成功路径', async () => {
  const { describeImages } = await import('../lib/vision/client.js')
  const config = {
    baseUrl: 'https://x', apiKey: 'k', model: 'm', protocol: 'chat_completions', anthropicThinking: 'omit',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }),
  }
  const controller = new AbortController()
  assert.equal(await describeImages(config, ['data:image/png;base64,AAA'], { signal: controller.signal }), 'ok')
})
