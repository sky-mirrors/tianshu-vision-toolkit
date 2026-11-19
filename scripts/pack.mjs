/**
 * 按 XiaoSi 插件库的包格式打包：tianshu.plugin.json + xiaosi.release.json +
 * xiaosi.contents.json + 全部运行文件，打成 ZIP。
 *
 * 规则来源：docs/developers/publishing.md「手动打包」。
 * - contents 的 sha256 按**原始文件字节**算，覆盖除自身与 dist/ 外的每个文件
 * - release 的 permission_digest = JCS(permissions) 的 UTF-8 字节 sha256
 * - compatibility.tpi 与清单 $tpi 一致；source_commit 为 40 位小写 git 摘要
 * - 发布者 ID 只能由开发者中心给出：缺它就报错，不编造默认值
 *
 * 用法：node scripts/pack.mjs --publisher-id <id> [--out <zip 路径>] [--platforms win32-x64]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 打包对象是**当前工作目录**：插件可能被复制到别处再打包，不能用脚本自身的父目录。
const ROOT = process.cwd()
const EXCLUDED_DIRS = new Set(['test', 'scripts', 'node_modules', '.git', 'dist'])
const CONTENTS_FILE = 'xiaosi.contents.json'

export function jcs(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${jcs(value[key])}`).join(',')}}`
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function listFiles(dir, base = dir) {
  const result = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...listFiles(path, base))
    else if (relative(base, path).replace(/\\/g, '/') !== CONTENTS_FILE) result.push(path)
  }
  return result
}

function parseArgs(argv) {
  const args = { platforms: 'win32-x64' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    args[key.slice(2)] = argv[i + 1]
    i += 1
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const publisherId = args['publisher-id']
  if (!publisherId || publisherId.trim() === '') {
    throw new Error('--publisher-id is required: only the developer centre can issue it; do not invent one')
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, 'tianshu.plugin.json'), 'utf8'))
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sourceCommit)) throw new Error(`bad source commit: ${sourceCommit}`)

  const release = {
    schema: 'xiaosi.release/1',
    release_id: args['release-id'] ?? `rel_${manifest.id.replace(/-/g, '_')}_${manifest.version.replace(/\./g, '')}`,
    publisher_id: publisherId,
    plugin_id: manifest.id,
    version: manifest.version,
    channel: 'stable',
    runtime: 'agent',
    compatibility: {
      tpi: manifest.$tpi,
      core: manifest.engines.tianshu,
      platforms: args.platforms.split(',').map(value => value.trim()).filter(Boolean),
    },
    data_schema: 1,
    migration_kind: 'none',
    permission_digest: sha256(Buffer.from(jcs(manifest.permissions ?? {}), 'utf8')),
    source_commit: sourceCommit,
  }

  // release 必须先落盘，否则它自己会漏出摘要表（contents 只排除自身）。
  writeFileSync(join(ROOT, 'xiaosi.release.json'), `${JSON.stringify(release, null, 2)}\n`)
  const files = listFiles(ROOT)
  const contentsPath = join(ROOT, CONTENTS_FILE)
  const contents = {
    schema: 'xiaosi.contents/1',
    files: Object.fromEntries(files.map(path => [
      relative(ROOT, path).replace(/\\/g, '/'),
      sha256(readFileSync(path)),
    ])),
  }
  writeFileSync(contentsPath, `${JSON.stringify(contents, null, 2)}\n`)

  const outPath = args.out ? resolve(args.out) : join(ROOT, 'dist', `${manifest.id}-${manifest.version}.zip`)
  mkdirSync(dirname(outPath), { recursive: true })
  if (existsSync(outPath)) rmSync(outPath)
  // 显式列出要打的文件：打包集合 = 摘要表 + contents 自己，杜绝把 .git/、dist/ 误装进包。
  const packageFiles = [...Object.keys(contents.files), CONTENTS_FILE]
  execFileSync('7z', ['a', '-tzip', '-mx=9', outPath, ...packageFiles], { cwd: ROOT, stdio: 'pipe' })

  const zipBytes = readFileSync(outPath)
  console.log(JSON.stringify({
    zip: outPath,
    zipBytes: zipBytes.length,
    fileCount: Object.keys(contents.files).length,
    permissionDigest: release.permission_digest,
    sourceCommit,
    releaseId: release.release_id,
  }, null, 2))
}

// 只在该脚本本身被直接运行时打包；后缀判断会把 verify-pack.mjs 也匹配进来。
if (process.argv[1] && /[/\\]pack\.mjs$/.test(process.argv[1])) main()
