import { test } from 'node:test'
import assert from 'node:assert/strict'

test('trace 环提取处理实心方块与孔洞', async () => {
  const { binarize, traceRings, ringArea, simplifyRing, ringToPath } = await import('../lib/tools/trace.js')
  const size = 8
  const data = new Uint8ClampedArray(size * size * 3).fill(255)
  // 外框 1..7，内部 3..5 挖空 → 应得到两个环（外框与孔洞）
  for (let y = 1; y < 7; y += 1) {
    for (let x = 1; x < 7; x += 1) {
      if (x >= 3 && x <= 5 && y >= 3 && y <= 5) continue
      const index = (y * size + x) * 3
      data[index] = 0; data[index + 1] = 0; data[index + 2] = 0
    }
  }
  const binary = binarize({ width: size, height: size, data })
  const rings = traceRings(binary)
  assert.equal(rings.length, 2, `应得到外框与孔洞两个环，实际 ${rings.length}`)
  const areas = rings.map(ringArea).sort((l, r) => r - l)
  assert.ok(areas[0] > areas[1], '外环面积应大于孔洞')

  const simplified = simplifyRing(rings[0], 1.5)
  assert.ok(simplified.length < rings[0].length, '简化后顶点数应减少')
  const polygon = ringToPath(simplified, { spline: false })
  assert.match(polygon, /^M/); assert.match(polygon, /Z$/)
  const splinePath = ringToPath(simplified, { spline: true })
  assert.match(splinePath, /C/, 'spline 模式应输出三次贝塞尔')
})

test('vision_trace 输出 SVG 并报告路径数；纯背景区域给出可操作的错误', async () => {
  const { createTraceTool } = await import('../lib/tools/trace.js')
  const { encodePng } = await import('../lib/png.js')
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'trace-edge-'))

  const size = 32
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let y = 8; y < 24; y += 1) {
    for (let x = 8; x < 24; x += 1) {
      const index = (y * size + x) * 4
      data[index] = 0; data[index + 1] = 0; data[index + 2] = 0; data[index + 3] = 255
    }
  }
  const shape = join(dir, 'shape.png')
  writeFileSync(shape, encodePng({ width: size, height: size, data }))

  const tool = createTraceTool()
  const result = await tool.execute({ args: { image: shape, output: join(dir, 'shape.svg') }, cwd: dir })
  assert.ok(!result.isError, result.content)
  const report = JSON.parse(result.content)
  assert.ok(report.pathCount >= 1)
  assert.ok(report.tracedScale >= 1)
  assert.ok(readFileSync(report.outputPath, 'utf8').includes('<path'))

  const blank = join(dir, 'blank.png')
  writeFileSync(blank, encodePng({ width: size, height: size, data: new Uint8ClampedArray(size * size * 4).fill(255) }))
  const empty = await tool.execute({ args: { image: blank }, cwd: dir })
  assert.equal(empty.isError, true)
  assert.match(empty.content, /0 paths/)
  assert.match(empty.content, /raise scale/)

  const badScale = await tool.execute({ args: { image: shape, scale: 9 }, cwd: dir })
  assert.equal(badScale.isError, true)
  rmSync(dir, { recursive: true, force: true })
})

test('trace 对角相接的两个像素必须是两个环，不能串成一个', async () => {
  const { binarize, traceRings, ringArea } = await import('../lib/tools/trace.js')
  const size = 8
  const data = new Uint8ClampedArray(size * size * 3).fill(255)
  for (const [x, y] of [[1, 1], [2, 2]]) {
    const index = (y * size + x) * 3
    data[index] = 0; data[index + 1] = 0; data[index + 2] = 0
  }
  const rings = traceRings(binarize({ width: size, height: size, data }))
  assert.equal(rings.length, 2, '4 邻接下对角像素不连通，应是两个独立环')
  assert.deepEqual(rings.map(ringArea).sort((l, r) => l - r), [1, 1])
})

test('trace 多个分离分量各成一个环，L 形仍是一个环', async () => {
  const { binarize, traceRings, ringArea } = await import('../lib/tools/trace.js')
  const size = 16
  const data = new Uint8ClampedArray(size * size * 3).fill(255)
  for (let y = 1; y < 5; y += 1) {
    for (let x = 1; x < 5; x += 1) {
      const i1 = (y * size + x) * 3
      data[i1] = 0; data[i1 + 1] = 0; data[i1 + 2] = 0
      const i2 = (y * size + x + 8) * 3
      data[i2] = 0; data[i2 + 1] = 0; data[i2 + 2] = 0
    }
  }
  const rings = traceRings(binarize({ width: size, height: size, data }))
  assert.equal(rings.length, 2)
  assert.deepEqual(rings.map(ringArea).sort((l, r) => r - l), [16, 16])

  const lData = new Uint8ClampedArray(size * size * 3).fill(255)
  for (const [x, y] of [[1, 1], [2, 1], [1, 2]]) {
    const index = (y * size + x) * 3
    lData[index] = 0; lData[index + 1] = 0; lData[index + 2] = 0
  }
  const lRings = traceRings(binarize({ width: size, height: size, data: lData }))
  assert.equal(lRings.length, 1, '连通形状应只有一个环')
  assert.equal(lRings[0].length, 9, 'L 形周长 8 段 + 闭合点')
})
