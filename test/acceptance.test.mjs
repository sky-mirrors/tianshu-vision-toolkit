/**
 * 验收标准（逐条对应需求原话）：
 *   上游的功能 → 10 工具都要有 timeoutMs；ground/detect 能出标注图；大图自动压缩
 *   天枢的现实 → 不引入 Python/额外运行时；缺凭据时给可执行提示
 *   天枢的特色 → promptContext 在用户边界注入可用性块；产物落 .rivet/artifacts/vision/
 *   补全与扔掉 → JPEG 明确报错指路；不实现 trace 色彩分层
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureImage } from './fixtures.mjs'

const EXPECTED_TOOLS = [
  'vision_glance', 'vision_ground', 'vision_detect', 'vision_crop', 'vision_pixel_diff',
  'vision_dominant_colors', 'vision_long_screenshot_ocr', 'vision_extract_foreground',
  'vision_html_screenshot', 'vision_trace',
]

async function loadPlugin() {
  const brand = Symbol.for('tianshu.tpi.plugin/v1')
  Object.defineProperty(globalThis, '__tianshuTPI', {
    value: Object.freeze({
      version: '1.0',
      defineTianshuPlugin: spec => Object.freeze({ ...spec, [brand]: { tpi: '1.0' } }),
    }),
    writable: false, configurable: true, enumerable: false,
  })
  const { default: plugin } = await import('../index.js?acceptance')
  return plugin
}

function solidRgba(width, height, rgb) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

test('十个工具都声明 timeoutMs 参数（上游每个工具都有）', async () => {
  const plugin = await loadPlugin()
  const tools = plugin.activate({}).tools
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...EXPECTED_TOOLS].sort())
  for (const tool of tools) {
    const properties = tool.inputSchema?.properties ?? {}
    assert.ok(properties.timeoutMs, `${tool.name} 缺少 timeoutMs`)
    assert.equal(properties.timeoutMs.type, 'integer')
  }
})

test('大图送模型前自动压缩，返回宽高描述被分析副本', async () => {
  const { loadRgb } = await import('../lib/image.js')
  const { encodePng } = await import('../lib/png.js')
  const { prepareForModel } = await import('../lib/vision/prepare.js')
  const dir = mkdtempSync(join(tmpdir(), 'vision-prep-'))
  try {
    const big = join(dir, 'big.png')
    writeFileSync(big, encodePng(solidRgba(2000, 400, [200, 30, 30])))
    const prepared = prepareForModel(loadRgb(big))
    assert.ok(Math.max(prepared.width, prepared.height) <= 1568, `压缩后长边应 <= 1568，实际 ${prepared.width}x${prepared.height}`)
    assert.equal(prepared.compressed, true)
    assert.equal(prepared.originalWidth, 2000)
    assert.ok(Math.abs(prepared.width / prepared.height - 5) < 0.02)

    const small = join(dir, 'small.png')
    writeFileSync(small, encodePng(solidRgba(320, 200, [10, 10, 10])))
    const untouched = prepareForModel(loadRgb(small))
    assert.equal(untouched.compressed, false)
    assert.equal(untouched.width, 320)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ground 的 preview 产出带框 PNG', async () => {
  const { encodePng, decodePng } = await import('../lib/png.js')
  const { createGroundTool } = await import('../lib/tools/ground.js')
  const dir = mkdtempSync(join(tmpdir(), 'vision-preview-'))
  try {
    const image = join(dir, 'plate.png')
    writeFileSync(image, encodePng(solidRgba(200, 120, [245, 245, 245])))
    const config = {
      baseUrl: 'https://x', apiKey: 'k', model: 'm', protocol: 'chat_completions', anthropicThinking: 'omit',
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '[{"box_2d":[100,100,500,500],"label":"btn"}]' } }] }),
      }),
      retryDelay: async () => {},
    }
    const result = JSON.parse((await createGroundTool(() => config).execute({
      args: { image, target: 'button', preview: true, previewOutput: 'boxed.png' }, cwd: dir,
    })).content)
    assert.ok(result.preview?.path, '必须返回 preview 产物')
    assert.ok(existsSync(result.preview.path))
    const drawn = decodePng(readFileSync(result.preview.path))
    assert.equal(drawn.width, 200)
    const borderX = Math.min(199, Math.round(200 * 500 / 1000))
    const midY = Math.round(120 * 100 / 1000)
    const index = (midY * drawn.width + borderX) * 4
    assert.notDeepEqual([drawn.data[index], drawn.data[index + 1], drawn.data[index + 2]], [245, 245, 245], '框线必须真的画上')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('用 promptContext 在用户边界注入可用性块，块名以插件 id 打头', async () => {
  const plugin = await loadPlugin()
  const blocks = []
  const contribution = plugin.activate({ promptContext: { setBlock: block => blocks.push(block) } })
  assert.equal(typeof contribution.lifecycle?.turnStart, 'function')
  await contribution.lifecycle.turnStart({ userInput: '看看这张图', turnMode: 'chat', turn: 1 })
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].startsWith('<vision-toolkit'), `块必须以插件 id 为前缀: ${blocks[0].slice(0, 40)}`)
  assert.match(blocks[0], /vision_glance/)
})

test('产物默认落在 .rivet/artifacts/vision/ 下', async () => {
  const { encodePng } = await import('../lib/png.js')
  const { cropTool } = await import('../lib/tools/crop.js')
  const dir = mkdtempSync(join(tmpdir(), 'vision-art-'))
  try {
    const image = join(dir, 'src.png')
    writeFileSync(image, encodePng(solidRgba(40, 40, [0, 0, 255])))
    const report = JSON.parse((await cropTool.execute({ args: { image, region: '0,0,20,20' }, cwd: dir })).content)
    const normalized = report.outputPath.replaceAll('\\', '/')
    assert.match(normalized, /\.rivet\/artifacts\/vision\/[^/]+$/, `产物路径不符合约定: ${report.outputPath}`)
    assert.ok(existsSync(report.outputPath))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('缺视觉凭据时给出可执行的提示', async () => {
  const { createGlanceTool } = await import('../lib/tools/glance.js')
  const { resolveVisionConfig } = await import('../lib/vision/config.js')
  // 工具的接口是 getConfig 工厂；传空环境才能走到「缺凭据」分支
  const tool = createGlanceTool(() => resolveVisionConfig({ env: {} }))
  await assert.rejects(
    () => tool.execute({ args: { images: [fixtureImage()] }, cwd: process.cwd() }),
    error => {
      assert.match(error.message, /VISION_BASE_URL/)
      assert.match(error.message, /config\.json/)
      return true
    },
  )
})

test('JPEG 交给像素工具时明确报错并指路', async () => {
  const { loadRgb } = await import('../lib/image.js')
  const dir = mkdtempSync(join(tmpdir(), 'vision-jpeg-'))
  try {
    const jpeg = join(dir, 'photo.jpg')
    writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]))
    assert.throws(() => loadRgb(jpeg), error => {
      assert.match(error.message, /JPEG/)
      assert.match(error.message, /PNG/i)
      return true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('trace 不实现色彩分层，报告里明确标注', async () => {
  const { encodePng } = await import('../lib/png.js')
  const { createTraceTool } = await import('../lib/tools/trace.js')
  const dir = mkdtempSync(join(tmpdir(), 'vision-trace-colour-'))
  try {
    const image = join(dir, 'shape.png')
    const raster = solidRgba(64, 64, [255, 255, 255])
    for (let y = 16; y < 48; y += 1) {
      for (let x = 16; x < 48; x += 1) {
        const index = (y * 64 + x) * 4
        raster.data[index] = 255; raster.data[index + 1] = 0; raster.data[index + 2] = 0
      }
    }
    writeFileSync(image, encodePng(raster))
    const report = JSON.parse((await createTraceTool().execute({ args: { image, color: true }, cwd: dir })).content)
    assert.match(report.note ?? '', /single-colour|not implemented/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 边界：压缩阈值、零尺寸、超时参数的非法值 ──────────────────────────

test('长边恰好 1568 不压缩，1569 才压缩', async () => {
  const { prepareForModel } = await import('../lib/vision/prepare.js')
  const raster = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 3).fill(20) })

  const exact = prepareForModel(raster(1568, 1000))
  assert.equal(exact.compressed, false, '恰好等于上限不应压缩')
  assert.equal(exact.width, 1568)

  const over = prepareForModel(raster(1569, 1000))
  assert.equal(over.compressed, true)
  assert.equal(over.width, 1568)
  assert.equal(over.originalWidth, 1569)
})

test('极小图不因取整被压成零宽', async () => {
  const { prepareForModel } = await import('../lib/vision/prepare.js')
  const tall = { width: 1, height: 5000, data: new Uint8ClampedArray(1 * 5000 * 3).fill(10) }
  const prepared = prepareForModel(tall)
  assert.equal(prepared.compressed, true)
  assert.ok(prepared.width >= 1, `宽度被压成 ${prepared.width}`)
  assert.equal(prepared.height, 1568)
  assert.equal(prepared.width * prepared.height, prepared.data.length / 3)
})

test('timeoutMs 传 0 或负数时不启用超时（按未指定处理）', async () => {
  const { raceTimeout } = await import('../lib/tools/timeout.js')
  const slow = new Promise(resolve => setTimeout(() => resolve('done'), 30))
  assert.equal(await raceTimeout(slow, 0, 'probe'), 'done', '0 不应触发超时')
  assert.equal(await raceTimeout(new Promise(r => setTimeout(() => r('done2'), 30)), -5, 'probe'), 'done2')
})

test('timeoutMs 到点后 reject 且错误里点明工具名与毫秒数', async () => {
  const { raceTimeout } = await import('../lib/tools/timeout.js')
  await assert.rejects(
    () => raceTimeout(new Promise(() => {}), 40, 'vision_probe'),
    /vision_probe: timed out after 40ms/,
  )
})
