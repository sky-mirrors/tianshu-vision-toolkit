import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePng, encodePng, readPngHeader } from '../lib/png.js'
import { parseRegion, cropRegion, resizeRgb } from '../lib/raster.js'
import { loadRgb } from '../lib/image.js'
import { cropTool } from '../lib/tools/crop.js'
import { pixelDiffTool } from '../lib/tools/pixel-diff.js'
import { dominantColorsTool } from '../lib/tools/dominant-colors.js'

function solid(width, height, rgb, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = alpha
  }
  return { width, height, data }
}

function writePng(path, raster) {
  writeFileSync(path, encodePng(raster))
}

function workspace() {
  return mkdtempSync(join(tmpdir(), 'vision-toolkit-test-'))
}

test('PNG 编解码往返保持像素与尺寸', () => {
  const source = solid(4, 3, [12, 200, 90])
  const bytes = encodePng(source)
  const back = decodePng(bytes)
  assert.equal(back.width, 4)
  assert.equal(back.height, 3)
  assert.deepEqual(Array.from(back.data), Array.from(source.data))
})

test('PNG 头部读取给出位深与色彩类型', () => {
  const header = readPngHeader(encodePng(solid(2, 2, [0, 0, 0])))
  assert.equal(header.bitDepth, 8)
  assert.equal(header.colorType, 6)
  assert.equal(header.interlace, 0)
})

test('非 PNG 输入被明确拒绝', () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  assert.throws(() => readPngHeader(bytes), /not a PNG file/)
})

test('parseRegion 处理反向端点、越界与空区域', () => {
  assert.deepEqual(parseRegion('10,10,2,2', 20, 20), { x1: 2, y1: 2, x2: 10, y2: 10, clamped: false })
  assert.deepEqual(parseRegion('-5,-5,40,40', 20, 20), { x1: 0, y1: 0, x2: 20, y2: 20, clamped: true })
  assert.throws(() => parseRegion('30,30,40,40', 20, 20), /is empty after clamping/)
  assert.throws(() => parseRegion('1,2,3', 20, 20), /four integers/)
})

test('cropRegion 取出的像素与源一致', () => {
  const raster = { width: 6, height: 6, data: new Uint8ClampedArray(6 * 6 * 3) }
  for (let i = 0; i < 36; i += 1) raster.data.fill(i, i * 3, i * 3 + 3)
  const crop = cropRegion(raster, { x1: 1, y1: 1, x2: 4, y2: 4 })
  assert.equal(crop.width, 3)
  assert.equal(crop.width * crop.height, 9)
  assert.equal(crop.data[0], raster.data[(1 * 6 + 1) * 3])
})

test('resizeRgb 保持纯色场的颜色不变', () => {
  const source = { width: 5, height: 5, data: new Uint8ClampedArray(5 * 5 * 3).fill(64) }
  for (const size of [[10, 10], [3, 3]]) {
    const out = resizeRgb(source, size[0], size[1])
    assert.equal(out.width, size[0])
    assert.equal(out.height, size[1])
    assert.ok(Array.from(out.data).every(v => v === 64))
  }
})

test('loadRgb 把透明像素合成到白底', () => {
  const dir = workspace()
  const path = join(dir, 'transparent.png')
  writePng(path, solid(2, 2, [0, 0, 0], 0))
  const rgb = loadRgb(path)
  assert.deepEqual(Array.from(rgb.data.slice(0, 3)), [255, 255, 255])
  rmSync(dir, { recursive: true, force: true })
})

test('vision_crop 写出裁切产物并报告 clamp', async () => {
  const dir = workspace()
  const image = join(dir, 'source.png')
  writePng(image, solid(8, 8, [10, 20, 30]))
  const result = await cropTool.execute({ args: { image, region: '2,2,6,6', scale: 2 }, cwd: dir })
  assert.ok(!result.isError)
  const report = JSON.parse(result.content)
  assert.deepEqual(report.region, { x1: 2, y1: 2, x2: 6, y2: 6 })
  assert.equal(report.width, 8)
  assert.equal(report.height, 8)
  assert.equal(report.clamped, false)
  const artifact = decodePng(readFileSync(report.outputPath))
  assert.equal(artifact.width, 8)
  assert.deepEqual(Array.from(artifact.data.slice(0, 3)), [10, 20, 30])
  rmSync(dir, { recursive: true, force: true })
})

test('vision_crop 对越界区域标记 clamped', async () => {
  const dir = workspace()
  const image = join(dir, 'source.png')
  writePng(image, solid(4, 4, [200, 100, 50]))
  const result = await cropTool.execute({ args: { image, region: '-2,-2,9,9' }, cwd: dir })
  const report = JSON.parse(result.content)
  assert.equal(report.clamped, true)
  assert.deepEqual(report.region, { x1: 0, y1: 0, x2: 4, y2: 4 })
  rmSync(dir, { recursive: true, force: true })
})

test('vision_pixel_diff 同图差异为 0', async () => {
  const dir = workspace()
  const image = join(dir, 'a.png')
  writePng(image, solid(8, 8, [100, 100, 100]))
  const result = await pixelDiffTool.execute({ args: { original: image, rebuilt: image, grid: 2 }, cwd: dir })
  const report = JSON.parse(result.content)
  assert.equal(report.overallDifferencePct, 0)
  assert.equal(report.worstRegions.length, 4)
  assert.equal(report.scaled, false)
  rmSync(dir, { recursive: true, force: true })
})

test('vision_pixel_diff 把整块改动定位到对应网格', async () => {
  const dir = workspace()
  const reference = join(dir, 'ref.png')
  const rebuilt = join(dir, 'rebuilt.png')
  writePng(reference, solid(8, 8, [0, 0, 0]))
  const altered = solid(8, 8, [0, 0, 0])
  for (let y = 4; y < 8; y += 1) {
    for (let x = 4; x < 8; x += 1) {
      const i = (y * 8 + x) * 4
      altered.data[i] = 255; altered.data[i + 1] = 255; altered.data[i + 2] = 255
    }
  }
  writePng(rebuilt, altered)
  const result = await pixelDiffTool.execute({ args: { original: reference, rebuilt, grid: 2, top: 1 }, cwd: dir })
  const report = JSON.parse(result.content)
  assert.equal(report.worstRegions.length, 1)
  assert.deepEqual(report.worstRegions[0].box, { x1: 4, y1: 4, x2: 8, y2: 8 })
  assert.equal(report.worstRegions[0].differencePct, 100)
  assert.ok(readFileSync(report.heatmap.path).length > 0)
  rmSync(dir, { recursive: true, force: true })
})

test('vision_pixel_diff 在尺寸不同时缩放并报告原始尺寸', async () => {
  const dir = workspace()
  const reference = join(dir, 'ref.png')
  const rebuilt = join(dir, 'rebuilt.png')
  writePng(reference, solid(8, 8, [50, 50, 50]))
  writePng(rebuilt, solid(4, 4, [50, 50, 50]))
  const result = await pixelDiffTool.execute({ args: { original: reference, rebuilt, grid: 2 }, cwd: dir })
  const report = JSON.parse(result.content)
  assert.equal(report.scaled, true)
  assert.deepEqual(report.rebuiltOriginalSize, { width: 4, height: 4 })
  assert.equal(report.rebuilt.width, 8)
  assert.equal(report.overallDifferencePct, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('vision_dominant_colors 对纯色区域给出 100% 占比', async () => {
  const dir = workspace()
  const image = join(dir, 'flat.png')
  writePng(image, solid(16, 16, [249, 250, 250]))
  const result = await dominantColorsTool.execute({ args: { image }, cwd: dir })
  const report = JSON.parse(result.content)
  assert.equal(report.analysis.mode, 'palette')
  assert.equal(report.analysis.colors.length, 1)
  assert.equal(report.analysis.colors[0].color, '#F9FAFA')
  assert.equal(report.analysis.colors[0].sharePct, 100)
  rmSync(dir, { recursive: true, force: true })
})

test('vision_dominant_colors 用像素从候选中裁定真实值', async () => {
  const dir = workspace()
  const image = join(dir, 'swatch.png')
  writePng(image, solid(16, 16, [245, 245, 245]))
  const result = await dominantColorsTool.execute({
    args: { image, candidates: ['#F9FAFA', '#F5F5F5', '#EDEDED'] },
    cwd: dir,
  })
  const report = JSON.parse(result.content)
  assert.equal(report.analysis.mode, 'candidates')
  assert.equal(report.analysis.winner, '#F5F5F5')
  assert.equal(report.analysis.matchedWithinTolerance, true)
  const winnerRow = report.analysis.candidates.find(c => c.color === '#F5F5F5')
  assert.equal(winnerRow.winner, true)
  assert.equal(winnerRow.sharePct, 100)
  rmSync(dir, { recursive: true, force: true })
})

test('vision_crop 在 scale 边界 1 与 8 上给出正确尺寸', async () => {
  const dir = workspace()
  const image = join(dir, 'source.png')
  writePng(image, solid(4, 4, [1, 2, 3]))
  const one = JSON.parse((await cropTool.execute({ args: { image, region: '0,0,4,4', scale: 1 }, cwd: dir })).content)
  assert.equal(one.width, 4)
  assert.equal(one.height, 4)
  const eight = JSON.parse((await cropTool.execute({ args: { image, region: '0,0,4,4', scale: 8 }, cwd: dir })).content)
  assert.equal(eight.width, 32)
  assert.equal(eight.height, 32)
  const over = await cropTool.execute({ args: { image, region: '0,0,4,4', scale: 9 }, cwd: dir })
  assert.equal(over.isError, true)
  rmSync(dir, { recursive: true, force: true })
})

test('vision_pixel_diff 在 grid 边界 1 与 32 上返回正确数量的区域', async () => {
  const dir = workspace()
  const image = join(dir, 'a.png')
  writePng(image, solid(32, 32, [10, 10, 10]))
  const one = JSON.parse((await pixelDiffTool.execute({ args: { original: image, rebuilt: image, grid: 1, top: 5 }, cwd: dir })).content)
  assert.equal(one.worstRegions.length, 1)
  assert.deepEqual(one.worstRegions[0].box, { x1: 0, y1: 0, x2: 32, y2: 32 })

  const many = JSON.parse((await pixelDiffTool.execute({ args: { original: image, rebuilt: image, grid: 32, top: 3 }, cwd: dir })).content)
  assert.equal(many.worstRegions.length, 3)
  const last = many.worstRegions[many.worstRegions.length - 1]
  assert.ok(last.box.x2 <= 32 && last.box.y2 <= 32 && last.box.x1 >= 0 && last.box.y1 >= 0)

  const tooHigh = await pixelDiffTool.execute({ args: { original: image, rebuilt: image, grid: 33 }, cwd: dir })
  assert.equal(tooHigh.isError, true)
  rmSync(dir, { recursive: true, force: true })
})

test('vision_pixel_diff 的 top 超过格子数时只返回实际格子', async () => {
  const dir = workspace()
  const image = join(dir, 'a.png')
  writePng(image, solid(8, 8, [0, 0, 0]))
  const report = JSON.parse((await pixelDiffTool.execute({ args: { original: image, rebuilt: image, grid: 2, top: 99 }, cwd: dir })).content)
  assert.equal(report.worstRegions.length, 4)
  rmSync(dir, { recursive: true, force: true })
})

test('vision_dominant_colors 接受 32 个候选，并拒绝 0 个与 33 个', async () => {
  const dir = workspace()
  const image = join(dir, 'swatch.png')
  writePng(image, solid(8, 8, [16, 16, 16]))
  const palette = Array.from({ length: 32 }, (_, i) => `#${(i * 7).toString(16).padStart(2, '0').repeat(3)}`)
  const report = JSON.parse((await dominantColorsTool.execute({ args: { image, candidates: palette }, cwd: dir })).content)
  assert.equal(report.analysis.candidates.length, 32)

  const none = await dominantColorsTool.execute({ args: { image, candidates: [] }, cwd: dir })
  assert.equal(none.isError, true)
  const tooMany = await dominantColorsTool.execute({ args: { image, candidates: [...palette, '#FFFFFF'] }, cwd: dir })
  assert.equal(tooMany.isError, true)
  rmSync(dir, { recursive: true, force: true })
})

test('vision_dominant_colors 在单像素区域上按整图坐标计算占比', async () => {
  const dir = workspace()
  const image = join(dir, 'pixel.png')
  const raster = solid(2, 2, [255, 0, 0])
  const index = (1 * 2 + 1) * 4
  raster.data[index] = 0; raster.data[index + 1] = 0; raster.data[index + 2] = 255
  writePng(image, raster)
  const report = JSON.parse((await dominantColorsTool.execute({ args: { image, region: '1,1,2,2' }, cwd: dir })).content)
  assert.equal(report.analysis.width, 1)
  assert.equal(report.analysis.colors[0].sharePct, 100)
  assert.equal(report.analysis.colors[0].color, '#0000FF')
  rmSync(dir, { recursive: true, force: true })
})
