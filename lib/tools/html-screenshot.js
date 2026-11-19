/**
 * vision_html_screenshot：把本地 HTML 文件渲染成 PNG。
 *
 * 本实现直接调用系统已装的 Chromium 系浏览器（`--headless --screenshot`），
 * 与上游 Playwright 适配器的差别：只有视口截图，没有 fullPage（需要拼接或多页）。
 * 只接受本地 .html/.htm，拒绝 URL 与 data URI——这个工具不该变成任意网页抓取器。
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { artifactName, resolveOutput } from '../artifacts.js'
import { readPngHeader } from '../png.js'

/** 从 PNG 字节读实际像素尺寸（不整幅解码）。 */
function peekPngSize(bytes) {
  const header = readPngHeader(bytes)
  return { width: header.width, height: header.height }
}

const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
}

/** 找浏览器可执行文件；找不到就报错并给出配置方式。 */
export function resolveBrowser(env = process.env, platform = process.platform) {
  const explicit = (env.VISION_BROWSER_PATH ?? '').trim()
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`VISION_BROWSER_PATH does not exist: ${explicit}`)
    return explicit
  }
  for (const candidate of CANDIDATES[platform] ?? []) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no Chromium-family browser found; set VISION_BROWSER_PATH to chrome.exe or msedge.exe')
}

function runBrowser(browser, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(browser, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, error => {
      if (error) rejectPromise(new Error(`browser screenshot failed: ${error.message.split('\n')[0]}`))
      else resolvePromise()
    })
  })
}

const sleep = ms => new Promise(ready => setTimeout(ready, ms))

/** 轮询 CDP 的 /json/version，直到浏览器就绪或超时。 */
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // 还没起来，继续等
    }
    await sleep(100)
  }
  throw new Error(`CDP did not open on port ${port} within ${timeoutMs}ms`)
}

/** 极简 CDP 客户端：发消息按 id 收结果，其余当事件留起来。 */
function connectCdp(wsUrl) {
  return new Promise((ready, fail) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    const events = []
    let nextId = 1
    socket.addEventListener('message', event => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      if (message.id !== undefined) {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (waiter) (message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result))
      } else {
        events.push(message)
      }
    })
    socket.addEventListener('error', () => fail(new Error('CDP websocket error')))
    socket.addEventListener('open', () => ready({
      events,
      send(method, params = {}) {
        const id = nextId
        nextId += 1
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej })
          socket.send(JSON.stringify({ id, method, params }))
        })
      },
      close() { try { socket.close() } catch { /* 已关闭 */ } },
    }))
  })
}

async function waitForEvent(cdp, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const index = cdp.events.findIndex(event => event.method === name)
    if (index >= 0) return cdp.events.splice(index, 1)[0].params
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${name}`)
}

/**
 * fullPage 分支：用 CDP 取页面真实高度再整页截图。
 * 与默认视口路径隔离——这里失败不会影响普通截图。
 */
export async function renderFullPage(browser, sourcePath, options) {
  const profile = mkdtempSync(join(tmpdir(), 'vision-shot-'))
  const port = 9000 + Math.floor(Math.random() * 1000)
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' })
  try {
    await waitForCdp(port, 15000)
    const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
    if (!targetResponse.ok) throw new Error(`cannot create CDP target: HTTP ${targetResponse.status}`)
    const target = await targetResponse.json()
    const cdp = await connectCdp(target.webSocketDebuggerUrl)
    try {
      await cdp.send('Page.enable')
      // CDP 路径下 --hide-scrollbars 不生效，滚动条会把内容宽度撑大约 20px，必须显式隐藏。
      await cdp.send('Emulation.setScrollbarsHidden', { hidden: true })
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false,
      })
      await cdp.send('Page.navigate', { url: pathToFileURL(resolve(sourcePath)).href })
      await waitForEvent(cdp, 'Page.loadEventFired', 15000)
      if (options.waitMs > 0) await sleep(options.waitMs)
      const metrics = await cdp.send('Page.getLayoutMetrics')
      const pageHeight = Math.ceil(metrics.cssContentSize?.height ?? options.height)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: options.width, height: pageHeight, deviceScaleFactor: 1, mobile: false,
      })
      await sleep(120)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      return { bytes: Buffer.from(shot.data, 'base64'), pageHeight }
    } finally {
      cdp.close()
    }
  } finally {
    child.kill()
    await sleep(200)
    rmSync(profile, { recursive: true, force: true })
  }
}

export function createHtmlScreenshotTool() {
  return {
    name: 'vision_html_screenshot',
    description:
      'Render an authorized local .html/.htm file with the installed Chromium-family browser and deliver a PNG. '
      + 'URLs and data URIs are rejected; only viewport capture is supported, not full-page.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'Local HTML path only.' },
        width: { type: 'integer', description: 'Viewport width; default 1280.' },
        height: { type: 'integer', description: 'Viewport height; default 800.' },
        waitMs: { type: 'integer', description: 'Virtual time budget in milliseconds; default 800.' },
        fullPage: { type: 'boolean', description: 'Capture the whole document (CDP) instead of the viewport.' },
        output: { type: 'string', description: 'Output PNG path; defaults to <source-stem>.shot.png.' },
      },
      required: ['source'],
    },
    pathParams: { source: 'read', output: 'write' },
    concurrencySafe: false,
    timeoutMs: 180000,
    async execute(call) {
      const args = call.args
      const sourcePath = isAbsolute(args.source) ? args.source : join(call.cwd, args.source)
      const extension = extname(sourcePath).toLowerCase()
      if (extension !== '.html' && extension !== '.htm') {
        return { content: 'vision_html_screenshot: source must be a local .html or .htm file', isError: true }
      }
      if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        return { content: `vision_html_screenshot: file not found: ${sourcePath}`, isError: true }
      }

      const width = args.width === undefined ? 1280 : args.width
      const height = args.height === undefined ? 800 : args.height
      const waitMs = args.waitMs === undefined ? 800 : args.waitMs
      if (!Number.isInteger(width) || width < 64 || width > 4096) {
        return { content: 'vision_html_screenshot: width must be 64-4096', isError: true }
      }
      if (!Number.isInteger(height) || height < 64 || height > 4096) {
        return { content: 'vision_html_screenshot: height must be 64-4096', isError: true }
      }
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) {
        return { content: 'vision_html_screenshot: waitMs must be 0-30000', isError: true }
      }

      const outputPath = resolveOutput(args.output, call.cwd, artifactName(sourcePath, '.shot.png'))
      if (!outputPath.toLowerCase().endsWith('.png')) {
        return { content: 'vision_html_screenshot: output must end with .png', isError: true }
      }

      const browser = resolveBrowser()
      if (args.fullPage === true) {
        const { bytes, pageHeight } = await renderFullPage(browser, sourcePath, { width, height, waitMs })
        writeFileSync(outputPath, bytes)
        // 整页截图的像素尺寸由页面内容决定，未必等于请求的 viewport：如实回报实际值。
        const { width: pixelWidth, height: pixelHeight } = peekPngSize(bytes)
        return {
          content: JSON.stringify({
            sourcePath, viewport: { width, height, scale: 1 },
            fullPage: true, pageHeight, width: pixelWidth, height: pixelHeight,
            outputPath, mimeType: 'image/png', bytes: bytes.length,
            ...(pixelWidth === width ? {} : { note: `full-page pixel width ${pixelWidth} differs from requested viewport width ${width} (page content overflow)` }),
          }, null, 2),
          rawPath: outputPath,
        }
      }
      await runBrowser(browser, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        `--window-size=${width},${height}`,
        `--virtual-time-budget=${waitMs}`,
        `--screenshot=${resolve(outputPath)}`,
        pathToFileURL(resolve(sourcePath)).href,
      ], 120000)

      if (!existsSync(outputPath)) {
        return { content: `vision_html_screenshot: browser produced no file at ${outputPath}`, isError: true }
      }
      const report = {
        sourcePath,
        viewport: { width, height, scale: 1 },
        outputPath,
        mimeType: 'image/png',
        bytes: statSync(outputPath).size,
        fullPageSupported: false,
      }
      return { content: JSON.stringify(report, null, 2), rawPath: outputPath }
    },
  }
}
