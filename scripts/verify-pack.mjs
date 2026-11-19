/**
 * 校验打好的发行包是否自洽：
 * 1) ZIP 内每个文件都在 contents 表里，且字节 sha256 与表一致
 * 2) contents 表里每个文件都真的在 ZIP 里（无幽灵条目）
 * 3) release.tpi == 清单.$tpi；release.plugin_id/version == 清单
 * 4) release.permission_digest == JCS(清单.permissions) 的 sha256
 *
 * 用法：node scripts/verify-pack.mjs <zip 路径>
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jcs } from './pack.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

const zipPath = resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  console.error('usage: node scripts/verify-pack.mjs <zip>')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'pack-verify-'))
const problems = []
try {
  execFileSync('7z', ['x', '-y', `-o${work}`, zipPath], { stdio: 'pipe' })
  const extracted = walk(work)
  const rel = path => relative(work, path).replace(/\\/g, '/')

  const contents = JSON.parse(readFileSync(join(work, 'xiaosi.contents.json'), 'utf8'))
  const release = JSON.parse(readFileSync(join(work, 'xiaosi.release.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(work, 'tianshu.plugin.json'), 'utf8'))

  for (const path of extracted) {
    const name = rel(path)
    if (name === 'xiaosi.contents.json') continue
    if (!(name in contents.files)) problems.push(`ZIP 内多出未登记文件: ${name}`)
    else if (sha256(readFileSync(path)) !== contents.files[name]) problems.push(`摘要不符: ${name}`)
  }
  for (const name of Object.keys(contents.files)) {
    if (!extracted.some(path => rel(path) === name)) problems.push(`contents 登记了 ZIP 中不存在的文件: ${name}`)
  }

  if (release.compatibility?.tpi !== manifest.$tpi) problems.push(`release.tpi=${release.compatibility?.tpi} 与清单 $tpi=${manifest.$tpi} 不一致`)
  if (release.plugin_id !== manifest.id) problems.push('release.plugin_id 与清单 id 不一致')
  if (release.version !== manifest.version) problems.push('release.version 与清单 version 不一致')
  const digest = sha256(Buffer.from(jcs(manifest.permissions ?? {}), 'utf8'))
  if (release.permission_digest !== digest) problems.push(`permission_digest 不符: ${release.permission_digest} != ${digest}`)
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(release.source_commit ?? '')) problems.push('source_commit 不是合法摘要')

  console.log(JSON.stringify({
    zip: zipPath,
    zipBytes: statSync(zipPath).size,
    extractedFiles: extracted.length,
    contentsEntries: Object.keys(contents.files).length,
    releaseId: release.release_id,
    problems,
    ok: problems.length === 0,
  }, null, 2))
} finally {
  rmSync(work, { recursive: true, force: true })
}
if (problems.length > 0) process.exit(1)
