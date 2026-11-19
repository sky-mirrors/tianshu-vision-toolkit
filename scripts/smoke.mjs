/**
 * 本地冒烟：模拟天枢宿主加载插件，把 10 个工具都跑一遍。
 *
 * A 段（宿主装配）：用 index.js 的真实装配路径，验证加载、清单一致、turnStart、
 *   以及所有**不需要视觉凭据**的工具——这一段等价于「装进天枢后能直接用」的部分。
 * B 段（凭据工具）：本机没有可用密钥，所以用工具工厂注入桩 config（桩 fetch 返回固定 JSON），
 *   只验证请求构造与回包解析链路成立；真实模型回答质量不在此列。
 *
 * 用法：node scripts/smoke.mjs
 * 退出码：全部通过 0，任一失败 1。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePng, readPngHeader } from '../lib/png.js'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}

let stubCalls = 0
const stubFetch = async (url, init) => {
  stubCalls += 1
  const body = JSON.parse(init.body)
  const text = body.messages?.[0]?.content?.find?.(part => part.type === 'text')?.text ?? ''
  const content = text.includes('box_2d')
    ? '[{"box_2d":[100,100,900,500],"label":"button"}]'
    : 'stub answer'
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
}

const stubConfig = {
  baseUrl: 'https://stub.local',
  apiKey: 'stub-key',
  model: 'stub-model',
  protocol: 'chat_completions',
  anthropicThinking: 'omit',
  fetchImpl: stubFetch,
  retryDelay: async () => {},
}

function makePng(path, width, height, rgb) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255
  }
  writeFileSync(path, encodePng({ width, height, data }))
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'vision-smoke-'))
  const brand = Symbol.for('tianshu.tpi.plugin/v1')
  Object.defineProperty(globalThis, '__tianshuTPI', {
    value: Object.freeze({ version: '1.0', defineTianshuPlugin: spec => Object.freeze({ ...spec, [brand]: { tpi: '1.0' } }) }),
    writable: false, configurable: true, enumerable: false,
  })

  const { default: plugin } = await import('../index.js?smoke')
  const blocks = []
  const contribution = plugin.activate({
    storage: { dataDir: () => join(work, 'plugin-data', 'vision-toolkit') },
    promptContext: { setBlock: block => blocks.push(block) },
  })
  const tools = Object.fromEntries(contribution.tools.map(tool => [tool.name, tool]))

  record('宿主装配：工具数', contribution.tools.length === 10, `${contribution.tools.length} 个`)
  await contribution.lifecycle.turnStart()
  record('turnStart 注入 promptContext', blocks.length === 1 && blocks[0].startsWith('<vision-toolkit'),
    `${blocks[0]?.length ?? 0} 字符`)

  // ── A 段：不需要视觉凭据的工具（走真实装配路径） ──
  const plate = join(work, 'plate.png')
  makePng(plate, 400, 240, [245, 245, 245])
  const swatch = join(work, 'swatch.png')
  makePng(swatch, 64, 64, [249, 250, 250])

  const crop = JSON.parse((await tools.vision_crop.execute({ args: { image: plate, region: '10,10,210,110', scale: 2 }, cwd: work })).content)
  const cropSize = readPngHeader(readFileSync(crop.outputPath))
  record('vision_crop', cropSize.width === 400 && cropSize.height === 200,
    `输出 ${cropSize.width}x${cropSize.height}，落在 ${crop.outputPath.split(/[\\/]/).slice(-3).join('/')}`)

  const diff = JSON.parse((await tools.vision_pixel_diff.execute({ args: { original: plate, rebuilt: plate, grid: 4 }, cwd: work })).content)
  // grid=4 有 16 个格子，但 top 默认 5，所以只返回 5 条
  record('vision_pixel_diff', diff.overallDifferencePct === 0 && diff.worstRegions.length === 5,
    `overall=${diff.overallDifferencePct} regions=${diff.worstRegions.length}`)

  // 边界：region 超出图像范围时必须 clamp 并标记，而不是报错或裁出错尺寸
  const clamped = JSON.parse((await tools.vision_crop.execute({ args: { image: plate, region: '-50,-50,9999,9999' }, cwd: work })).content)
  record('vision_crop 越界 clamp', clamped.clamped === true && clamped.region.x2 === 400 && clamped.region.y2 === 240,
    `clamped=${clamped.clamped} region=${JSON.stringify(clamped.region)}`)

  // 边界：钳制后为空的 region 必须报错，不能静默产出空图
  // 工具实现是 throw（宿主 wrapper 会转成错误内容），这里要接住异常来判定
  let clampedEmptyOk = false
  let clampedEmptyDetail = ''
  try {
    const outcome = await tools.vision_crop.execute({ args: { image: plate, region: '5000,5000,6000,6000' }, cwd: work })
    clampedEmptyOk = outcome.isError === true || /empty after clamping/.test(String(outcome.content))
    clampedEmptyDetail = String(outcome.content).split('\n')[0].slice(0, 70)
  } catch (error) {
    clampedEmptyOk = /empty after clamping/.test(error.message)
    clampedEmptyDetail = error.message.slice(0, 70)
  }
  record('vision_crop 空区域报错', clampedEmptyOk, clampedEmptyDetail)

  const colors = JSON.parse((await tools.vision_dominant_colors.execute({ args: { image: swatch }, cwd: work })).content)
  record('vision_dominant_colors', colors.analysis.colors[0]?.color === '#F9FAFA',
    `${colors.analysis.colors[0]?.color} ${colors.analysis.colors[0]?.sharePct}%`)

  const fg = JSON.parse((await tools.vision_extract_foreground.execute({
    args: { image: plate, region: '0,0,400,240', mode: 'dark', dark: 250, output: 'fg.png' }, cwd: work,
  })).content)
  record('vision_extract_foreground', fg.width > 0 && fg.inkPixels > 0, `${fg.width}x${fg.height} ink=${fg.inkPixels}`)

  // trace 需要真有墨迹的图：白底上一个黑块
  const shape = join(work, 'shape.png')
  const shapeData = new Uint8ClampedArray(200 * 200 * 4).fill(255)
  for (let y = 50; y < 150; y += 1) {
    for (let x = 50; x < 150; x += 1) {
      const index = (y * 200 + x) * 4
      shapeData[index] = 0; shapeData[index + 1] = 0; shapeData[index + 2] = 0; shapeData[index + 3] = 255
    }
  }
  writeFileSync(shape, encodePng({ width: 200, height: 200, data: shapeData }))
  const trace = JSON.parse((await tools.vision_trace.execute({ args: { image: shape, scale: 1 }, cwd: work })).content)
  record('vision_trace', trace.pathCount >= 1, `paths=${trace.pathCount ?? 0} rings=${trace.ringCount ?? 0}`)

  const htmlSource = join(work, 'page.html')
  writeFileSync(htmlSource, '<!doctype html><html><body style="margin:0;background:#0af"><div style="height:1200px">tall</div></body></html>')
  const shot = await tools.vision_html_screenshot.execute({ args: { source: htmlSource, width: 400, height: 300, fullPage: true }, cwd: work })
  if (shot.isError) record('vision_html_screenshot(fullPage)', false, shot.content.slice(0, 90))
  else {
    const report = JSON.parse(shot.content)
    record('vision_html_screenshot(fullPage)', report.pageHeight >= 1200, `pageHeight=${report.pageHeight} png=${report.width}x${report.height}`)
  }

  // 真实装配下，无凭据的视觉工具必须给出可执行提示（而不是静默或崩溃）
  try {
    await tools.vision_glance.execute({ args: { images: [plate] }, cwd: work })
    record('无凭据时报错指路', false, '居然没报错')
  } catch (error) {
    record('无凭据时报错指路', /VISION_BASE_URL/.test(error.message) && /config\.json/.test(error.message),
      error.message.split('\n')[0])
  }

  // ── B 段：凭据工具（注入桩 config 的工具工厂） ──
  const { createGlanceTool } = await import('../lib/tools/glance.js')
  const { createGroundTool } = await import('../lib/tools/ground.js')
  const { createDetectTool } = await import('../lib/tools/detect.js')
  const { createLongScreenshotOcrTool } = await import('../lib/tools/long-ocr.js')

  const glance = JSON.parse((await createGlanceTool(() => stubConfig).execute({ args: { images: [plate], query: 'what' }, cwd: work })).content)
  record('vision_glance（桩端点）', glance.mode === 'qa' && glance.answer === 'stub answer', `mode=${glance.mode}`)

  const ground = JSON.parse((await createGroundTool(() => stubConfig).execute({ args: { image: plate, target: 'button', preview: true }, cwd: work })).content)
  const previewOk = ground.preview?.path ? existsSync(ground.preview.path) : false
  record('vision_ground+preview（桩端点）', ground.matches.length === 1 && previewOk,
    `box=${JSON.stringify(ground.matches[0]?.box)} preview=${previewOk}`)

  const detect = JSON.parse((await createDetectTool(() => stubConfig).execute({ args: { image: plate, category: 'icons' }, cwd: work })).content)
  record('vision_detect（桩端点）', detect.elementCount >= 1, `count=${detect.elementCount}`)

  const long = JSON.parse((await createLongScreenshotOcrTool(() => stubConfig).execute({ args: { image: plate }, cwd: work })).content)
  record('vision_long_screenshot_ocr（桩端点）', long.chunkCount >= 1, `chunks=${long.chunkCount} complete=${long.complete}`)

  console.log(`\n桩视觉请求 ${stubCalls} 次`)
  const failed = results.filter(row => !row.ok)
  console.log(`结果：${results.length - failed.length}/${results.length} 通过`)
  rmSync(work, { recursive: true, force: true })
  if (failed.length > 0) {
    console.log('失败项：', failed.map(row => row.name).join(', '))
    process.exit(1)
  }
}

main().catch(error => {
  console.error('SMOKE ERROR', error)
  process.exit(1)
})
