/**
 * 命令行入口：不经过天枢宿主，直接用本插件的工具处理图片。
 *
 * 用途有两个：
 *  1) 宿主还没加载插件（或安装渠道没打通）时，先把功能用起来；
 *  2) 排障时绕开宿主，确认问题出在插件还是在宿主接线。
 *
 * 用法：
 *   node scripts/vision.mjs doctor
 *   node scripts/vision.mjs list
 *   node scripts/vision.mjs crop    --image a.png --region 0,0,200,120 [--scale 2] [--output out.png]
 *   node scripts/vision.mjs diff    --original a.png --rebuilt b.png [--grid 6] [--top 5]
 *   node scripts/vision.mjs colors  --image a.png [--region ...] [--candidates "#fff,#000"]
 *   node scripts/vision.mjs ocr     --image tall.png [--splitOnly] [--mode chat]
 *   node scripts/vision.mjs fg      --image a.png [--region ...] [--mode dark]
 *   node scripts/vision.mjs trace   --image a.png [--region ...] [--spline]
 *   node scripts/vision.mjs html    --source page.html [--width 1200] [--height 800] [--fullPage]
 *   node scripts/vision.mjs glance  --images a.png[,b.png] [--query "..." | --ocr] [--region ...]
 *   node scripts/vision.mjs ground  --image a.png --target "登录按钮" [--preview]
 *   node scripts/vision.mjs detect  --image a.png [--category 按钮] [--preview]
 *
 * 视觉类命令（glance/ground/detect/ocr）需要可用凭据；`doctor` 会告诉你去哪配。
 * 退出码：成功 0，参数错误 2，执行失败 1。
 */
import { resolveVisionConfig } from '../lib/vision/config.js'
import { discoverTianshuVisionProvider, listVisionCandidates, rivetHomeFromDataDir } from '../lib/vision/discover.js'
import { cropTool } from '../lib/tools/crop.js'
import { pixelDiffTool } from '../lib/tools/pixel-diff.js'
import { dominantColorsTool } from '../lib/tools/dominant-colors.js'
import { createGlanceTool } from '../lib/tools/glance.js'
import { createGroundTool } from '../lib/tools/ground.js'
import { createDetectTool } from '../lib/tools/detect.js'
import { createLongScreenshotOcrTool } from '../lib/tools/long-ocr.js'
import { createExtractForegroundTool } from '../lib/tools/extract-fg.js'
import { createTraceTool } from '../lib/tools/trace.js'
import { createHtmlScreenshotTool } from '../lib/tools/html-screenshot.js'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.cwd()

/**
 * 定位天枢的 rivet home，用来复用宿主里已配好的 provider。
 * 顺序：环境变量 → 安装目录旁的 TianshuData/.rivet → 当前目录的 .rivet（本地兜底）。
 * 只认这两个候选：曾试过 LOCALAPPDATA 下的 Tianshu 路径，实测不存在，已移除。
 */
function locateRivetHome() {
  const explicit = (process.env.TIANSHU_RIVET_HOME ?? '').trim()
  if (explicit) return explicit
  const tianshuHome = 'D:/Tianshu/TianshuData/.rivet'
  if (existsSync(join(tianshuHome, 'config.json'))) return tianshuHome
  return join(cwd, '.rivet')
}

const RIVET_HOME = locateRivetHome()
/** 插件数据目录：与宿主给的 storage.dataDir() 同构，便于 config.json 放同一处。 */
const DATA_DIR = join(RIVET_HOME, 'plugin-data', 'vision-toolkit')
const getConfig = () => resolveVisionConfig({ dataDir: DATA_DIR })

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { flags[name] = true; continue }
    flags[name] = next
    i += 1
  }
  return flags
}

const asList = value => (value === undefined ? undefined : String(value).split(',').map(item => item.trim()).filter(Boolean))
const asInt = value => (value === undefined ? undefined : Number.parseInt(String(value), 10))

function fail(message, code = 2) {
  console.error(message)
  process.exit(code)
}

const COMMANDS = {
  list() {
    return ['vision_glance', 'vision_ground', 'vision_detect', 'vision_crop', 'vision_pixel_diff',
      'vision_dominant_colors', 'vision_long_screenshot_ocr', 'vision_extract_foreground',
      'vision_html_screenshot', 'vision_trace'].map(name => ({ name }))
  },

  doctor() {
    const report = { cwd, dataDir: DATA_DIR, dataDirExists: existsSync(DATA_DIR), env: {}, tianshu: {}, result: '' }
    for (const key of ['VISION_BASE_URL', 'VISION_API_KEY', 'VISION_MODEL', 'VISION_API_PROTOCOL']) {
      report.env[key] = process.env[key] === undefined ? '(unset)' : '(set)'
    }
    const home = rivetHomeFromDataDir(DATA_DIR)
    report.tianshu.rivetHome = home
    report.tianshu.candidates = listVisionCandidates({ dataDir: DATA_DIR })
    report.tianshu.discovered = discoverTianshuVisionProvider({ dataDir: DATA_DIR })?.from ?? null
    try {
      const config = getConfig()
      report.result = `ready via ${config.source ?? 'unknown'} → ${config.baseUrl} model=${config.model}`
    } catch (error) {
      report.result = error.message
    }
    return report
  },

  async crop(flags) {
    if (!flags.image || !flags.region) fail('crop 需要 --image 与 --region')
    return run(cropTool, {
      image: flags.image, region: flags.region,
      ...(flags.scale === undefined ? {} : { scale: asInt(flags.scale) }),
      ...(flags.output === undefined ? {} : { output: flags.output }),
      ...(flags.timeoutMs === undefined ? {} : { timeoutMs: asInt(flags.timeoutMs) }),
    })
  },

  async diff(flags) {
    if (!flags.original || !flags.rebuilt) fail('diff 需要 --original 与 --rebuilt')
    return run(pixelDiffTool, {
      original: flags.original, rebuilt: flags.rebuilt,
      ...(flags.grid === undefined ? {} : { grid: asInt(flags.grid) }),
      ...(flags.top === undefined ? {} : { top: asInt(flags.top) }),
      ...(flags.output === undefined ? {} : { output: flags.output }),
    })
  },

  async colors(flags) {
    if (!flags.image) fail('colors 需要 --image')
    return run(dominantColorsTool, {
      image: flags.image,
      ...(flags.region === undefined ? {} : { region: flags.region }),
      ...(flags.candidates === undefined ? {} : { candidates: asList(flags.candidates) }),
      ...(flags.top === undefined ? {} : { top: asInt(flags.top) }),
    })
  },

  async glance(flags) {
    const images = asList(flags.images ?? flags.image)
    if (images === undefined || images.length === 0) fail('glance 需要 --images a.png[,b.png]')
    return run(createGlanceTool(getConfig), {
      images,
      ...(flags.query === undefined ? {} : { query: flags.query }),
      ...(flags.ocr === true ? { ocr: true } : {}),
      ...(flags.ocrHint === undefined ? {} : { ocrHint: flags.ocrHint }),
      ...(flags.region === undefined ? {} : { region: flags.region }),
      ...(flags.timeoutMs === undefined ? {} : { timeoutMs: asInt(flags.timeoutMs) }),
    })
  },

  async ground(flags) {
    if (!flags.image || !flags.target) fail('ground 需要 --image 与 --target')
    return run(createGroundTool(getConfig), {
      image: flags.image, target: flags.target,
      ...(flags.region === undefined ? {} : { region: flags.region }),
      ...(flags.preview === true ? { preview: true } : {}),
      ...(flags.previewOutput === undefined ? {} : { previewOutput: flags.previewOutput }),
    })
  },

  async detect(flags) {
    if (!flags.image) fail('detect 需要 --image')
    return run(createDetectTool(getConfig), {
      image: flags.image,
      ...(flags.category === undefined ? {} : { category: flags.category }),
      ...(flags.region === undefined ? {} : { region: flags.region }),
      ...(flags.preview === true ? { preview: true } : {}),
    })
  },

  async ocr(flags) {
    if (!flags.image) fail('ocr 需要 --image')
    return run(createLongScreenshotOcrTool(getConfig), {
      image: flags.image,
      ...(flags.mode === undefined ? {} : { mode: flags.mode }),
      ...(flags.splitOnly === true ? { splitOnly: true } : {}),
      ...(flags.output === undefined ? {} : { output: flags.output }),
      ...(flags.jobs === undefined ? {} : { jobs: asInt(flags.jobs) }),
      ...(flags.targetHeight === undefined ? {} : { targetHeight: asInt(flags.targetHeight) }),
    })
  },

  async fg(flags) {
    if (!flags.image) fail('fg 需要 --image')
    return run(createExtractForegroundTool(), {
      image: flags.image,
      ...(flags.region === undefined ? {} : { region: flags.region }),
      ...(flags.mode === undefined ? {} : { mode: flags.mode }),
      ...(flags.output === undefined ? {} : { output: flags.output }),
    })
  },

  async trace(flags) {
    if (!flags.image) fail('trace 需要 --image')
    return run(createTraceTool(), {
      image: flags.image,
      ...(flags.region === undefined ? {} : { region: flags.region }),
      ...(flags.scale === undefined ? {} : { scale: asInt(flags.scale) }),
      ...(flags.spline === true ? { spline: true } : {}),
      ...(flags.output === undefined ? {} : { output: flags.output }),
    })
  },

  async html(flags) {
    if (!flags.source) fail('html 需要 --source page.html')
    return run(createHtmlScreenshotTool(), {
      source: flags.source,
      ...(flags.width === undefined ? {} : { width: asInt(flags.width) }),
      ...(flags.height === undefined ? {} : { height: asInt(flags.height) }),
      ...(flags.waitMs === undefined ? {} : { waitMs: asInt(flags.waitMs) }),
      ...(flags.fullPage === true ? { fullPage: true } : {}),
      ...(flags.output === undefined ? {} : { output: flags.output }),
    })
  },
}

async function run(tool, args) {
  const result = await tool.execute({ args, cwd })
  const text = typeof result?.content === 'string' ? result.content : JSON.stringify(result)
  console.log(text)
  return result?.isError === true ? 1 : 0
}

const [command, ...rest] = process.argv.slice(2)
if (!command || command === 'help' || command === '--help') {
  console.log('commands:', Object.keys(COMMANDS).join(', '))
  process.exit(0)
}
const handler = COMMANDS[command]
if (!handler) fail(`unknown command ${command}; try: ${Object.keys(COMMANDS).join(', ')}`)

// 数据目录建不出来就不能往下跑：多半是只读盘或权限问题，直接点名路径而不是抛栈
try {
  mkdirSync(DATA_DIR, { recursive: true })
} catch (error) {
  console.error(`无法创建插件数据目录 ${DATA_DIR}：${error.message}`)
  console.error('可设置 TIANSHU_RIVET_HOME 指向可写目录后重试。')
  process.exit(1)
}
try {
  const outcome = await handler(parseFlags(rest))
  if (typeof outcome === 'number') process.exit(outcome)
  // list / doctor 这类同步命令返回对象：统一在这里打印
  if (outcome !== undefined) console.log(JSON.stringify(outcome, null, 2))
  process.exit(0)
} catch (error) {
  console.error(`${command}: ${error.message}`)
  process.exit(1)
}
