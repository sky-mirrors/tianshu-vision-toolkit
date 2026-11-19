/**
 * 打包脚本的契约测试：JCS 规范化、摘要算法、以及打包产物能被 verify-pack 认可；
 * 故意篡改的包必须被拒绝（否则 verify 只是装饰）。
 *
 * 依赖系统 7z（本机为 chocolatey/7-Zip）。缺 7z 直接失败并给出明确原因，不静默跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jcs, sha256 } from '../scripts/pack.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')

function sevenZip() {
  try {
    execFileSync('7z', ['i'], { stdio: 'pipe' })
  } catch {
    throw new Error('本测试需要系统 7z（7-Zip）：未找到可执行的 7z')
  }
}

test('jcs 按键名排序、无空白，且对数组与嵌套对象一致', () => {
  assert.equal(jcs({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(jcs({}), '{}')
  assert.equal(jcs({ nested: { y: true, x: null } }), '{"nested":{"x":null,"y":true}}')
  assert.equal(jcs([3, 1]), '[3,1]')
  assert.equal(jcs({ list: [{ b: 1, a: 2 }] }), '{"list":[{"a":2,"b":1}]}')
  assert.equal(jcs('a"b'), '"a\\"b"')
})

test('sha256 与 node:crypto 一致，且 permissions 空对象摘要稳定', () => {
  const bytes = Buffer.from('hello', 'utf8')
  assert.equal(sha256(bytes), createHash('sha256').update(bytes).digest('hex'))
  // 空权限对象的 JCS 是 '{}'，其摘要与发布文档示例里的值一致
  assert.equal(sha256(Buffer.from(jcs({}), 'utf8')),
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
})

test('打包产物自洽：verify-pack 返回 ok 且无 problems', () => {
  sevenZip()
  const work = mkdtempSync(join(tmpdir(), 'pack-e2e-'))
  try {
    mkdirSync(join(work, 'lib'))
    writeFileSync(join(work, 'tianshu.plugin.json'), JSON.stringify({
      $tpi: '1.0',
      kind: 'tianshu.plugin',
      id: 'pack-probe',
      displayName: '打包探针',
      version: '0.0.1',
      description: 'pack test fixture',
      runtime: 'agent',
      entry: 'index.js',
      capabilities: ['tools'],
      contributes: { tools: [{ name: 'pack_probe', description: 'probe' }], lifecycle: [] },
      permissions: {},
      engines: { tianshu: '>=4.0.4' },
    }, null, 2))
    writeFileSync(join(work, 'index.js'), 'export default 1\n')
    writeFileSync(join(work, 'lib', 'a.js'), 'export const a = 1\n')

    execFileSync('git', ['init', '-q'], { cwd: work })
    execFileSync('git', ['add', '.'], { cwd: work })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: work })

    execFileSync('node', [join(SCRIPTS, 'pack.mjs'), '--publisher-id', 'publisher-fixture'], { cwd: work, stdio: 'pipe' })
    const zip = join(work, 'dist', 'pack-probe-0.0.1.zip')
    const report = JSON.parse(execFileSync('node', [join(SCRIPTS, 'verify-pack.mjs'), zip], { cwd: work, encoding: 'utf8' }))
    assert.equal(report.ok, true, `problems: ${JSON.stringify(report.problems)}`)
    assert.equal(report.problems.length, 0)
    assert.ok(report.contentsEntries >= 3)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('被篡改的包必须被 verify-pack 拒绝（摘要不符 / tpi 不一致 / 幽灵条目）', () => {
  sevenZip()
  const work = mkdtempSync(join(tmpdir(), 'pack-bad-'))
  try {
    writeFileSync(join(work, 'tianshu.plugin.json'), JSON.stringify({
      $tpi: '1.0', kind: 'tianshu.plugin', id: 'bad-pack', displayName: 'bad', version: '0.0.1',
      description: 'tampered fixture', runtime: 'agent', entry: 'index.js',
      capabilities: ['tools'], contributes: { tools: [{ name: 'bad_tool', description: 'x' }], lifecycle: [] },
      permissions: {}, engines: { tianshu: '>=4.0.4' },
    }, null, 2))
    writeFileSync(join(work, 'index.js'), 'export default 1\n')

    // 故意写错摘要，并把 ghost.js 登记进表里但文件不存在
    writeFileSync(join(work, 'xiaosi.contents.json'), JSON.stringify({
      schema: 'xiaosi.contents/1',
      files: {
        'tianshu.plugin.json': 'deadbeef'.repeat(8),
        'index.js': sha256(readFileSync(join(work, 'index.js'))),
        'ghost.js': 'f'.repeat(64),
      },
    }, null, 2))
    writeFileSync(join(work, 'xiaosi.release.json'), JSON.stringify({
      schema: 'xiaosi.release/1', release_id: 'rel_bad', publisher_id: 'p', plugin_id: 'bad-pack',
      version: '0.0.1', channel: 'stable', runtime: 'agent',
      compatibility: { tpi: '2.0', core: '>=4.0.4', platforms: ['win32-x64'] },
      data_schema: 1, migration_kind: 'none', permission_digest: sha256(Buffer.from(jcs({}), 'utf8')),
      source_commit: '0'.repeat(40),
    }, null, 2))

    const zip = join(work, 'bad.zip')
    execFileSync('7z', ['a', '-tzip', zip, '.'], { cwd: work, stdio: 'pipe' })
    const run = () => {
      try {
        execFileSync('node', [join(SCRIPTS, 'verify-pack.mjs'), zip], { cwd: work, stdio: 'pipe' })
        return { ok: true, problems: [] }
      } catch (error) {
        const stdout = String(error.stdout ?? '')
        return { ok: false, problems: JSON.parse(stdout || '{}').problems ?? [stdout] }
      }
    }
    const report = run()
    assert.equal(report.ok, false, '篡改包必须被拒绝')
    const text = report.problems.join('\n')
    assert.match(text, /摘要不符: tianshu\.plugin\.json/)
    assert.match(text, /ghost\.js/)
    assert.match(text, /release\.tpi=2\.0 与清单 \$tpi=1\.0 不一致/)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
