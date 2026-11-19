/**
 * 产物路径约定：默认落在会话目录下的 `.rivet/artifacts/vision/`。
 *
 * 天枢把项目侧的产物放在 `.rivet/`（会话、知识、计划都在这里），插件产物跟着走，
 * 用户在一个地方就能找到全部输出；显式给了 output 就尊重用户路径。
 */
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const ARTIFACT_DIR = ['.rivet', 'artifacts', 'vision']

/** 绝对路径直接返回；相对路径相对 call.cwd。 */
export function resolveOutput(userPath, cwd, fallbackName) {
  const target = userPath === undefined
    ? join(cwd, ...ARTIFACT_DIR, fallbackName)
    : (isAbsolute(userPath) ? userPath : join(cwd, userPath))
  mkdirSync(join(target, '..'), { recursive: true })
  return target
}

/** 去掉扩展名后的文件名主干（用于默认产物名）。 */
export function stem(path) {
  return path.slice(0, path.length - extensionOf(path).length)
}

/** 只取文件名部分（默认产物名不能带目录，否则拼到 artifacts 目录会拼出非法路径）。 */
export function baseName(path) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(slash + 1)
}

/** 输入文件的基名 + 后缀：`shot.png` + `.crop.png` → `shot.crop.png`。 */
export function artifactName(inputPath, suffix) {
  return `${stem(baseName(inputPath))}${suffix}`
}

function extensionOf(path) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dot = path.lastIndexOf('.')
  return dot > slash ? path.slice(dot) : ''
}
