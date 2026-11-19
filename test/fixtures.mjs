/**
 * 测试夹具：不依赖仓库里任何既有图片/HTML，全部按需现造。
 * 这样 `node --test test/*.test.mjs` 在任何目录都能跑（发布仓库不带上游素材）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePng } from '../lib/png.js'

/** 生成一张纯色 PNG 并返回路径。 */
export function fixtureImage(rgb = [200, 60, 60], width = 32, height = 32) {
  const dir = mkdtempSync(join(tmpdir(), 'vision-fixture-'))
  const path = join(dir, 'fixture.png')
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255
  }
  writeFileSync(path, encodePng({ width, height, data }))
  return path
}

/** 生成一个最小 HTML 文件并返回路径。 */
export function fixtureHtml(body = '<div style="height:200px">fixture</div>') {
  const dir = mkdtempSync(join(tmpdir(), 'vision-fixture-html-'))
  const path = join(dir, 'page.html')
  writeFileSync(path, `<!doctype html><html><body style="margin:0">${body}</body></html>`)
  return path
}
