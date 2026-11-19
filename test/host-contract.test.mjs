/**
 * 宿主契约测试：模拟天枢的 TPI 1.0 握手，验证插件自报清单与入口实际贡献一致。
 *
 * 宿主要求「清单里声明的工具必须和入口提供的一一对应」，不一致就不接入会话。
 * 这条测试是唯一能在宿主之外复现该拒绝条件的检查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ENTRY = pathToFileURL(join(ROOT, 'index.js')).href

// ESM 模块缓存按 URL 键控：不同场景用不同 query，避免首次失败的加载结果污染后续用例。
const ENTRY_WITH_HOST = `${ENTRY}?host`
const ENTRY_WITHOUT_HOST = `${ENTRY}?no-sdk`

function installHostStub() {
  const brand = Symbol.for('tianshu.tpi.plugin/v1')
  const defineTianshuPlugin = spec => Object.freeze({ ...spec, [brand]: { tpi: '1.0' } })
  Object.defineProperty(globalThis, '__tianshuTPI', {
    value: Object.freeze({ version: '1.0', defineTianshuPlugin }),
    writable: false,
    configurable: true,
    enumerable: false,
  })
  return brand
}

test('入口在宿主 SDK 缺席时拒绝加载', async () => {
  const saved = globalThis.__tianshuTPI
  delete globalThis.__tianshuTPI
  try {
    await assert.rejects(
      () => import(ENTRY_WITHOUT_HOST),
      /not running inside Tianshu/,
    )
  } finally {
    Object.defineProperty(globalThis, '__tianshuTPI', {
      value: saved, writable: false, configurable: true, enumerable: false,
    })
  }
})

test('清单声明的工具与入口贡献的工具一一对应', async () => {
  const brand = installHostStub()
  const { default: plugin } = await import(ENTRY_WITH_HOST)
  const manifest = JSON.parse(readFileSync(join(ROOT, 'tianshu.plugin.json'), 'utf8'))

  assert.ok(plugin[brand], '入口必须导出带宿主私有 symbol 的定义对象')
  assert.equal(plugin.id, manifest.id)

  const declared = manifest.contributes.tools.map(t => t.name).sort()
  const contributed = plugin.activate({}).tools.map(t => t.name).sort()
  assert.deepEqual(contributed, declared)
  assert.equal(manifest.capabilities.includes('tools'), true)

  const names = manifest.contributes.tools.map(t => t.name)
  assert.equal(new Set(names).size, names.length, '工具名不能重复')
  for (const name of names) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} 必须是小写下划线格式`)
  }
})

test('每个工具的形状满足宿主接口', async () => {
  installHostStub()
  const { default: plugin } = await import(ENTRY_WITH_HOST)
  const tools = plugin.activate({}).tools
  assert.ok(tools.length > 0)
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.description.length <= 200, `${tool.name} 的描述超过 200 字符`)
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('清单通过 TPI 1.0 描述层的字段约束', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'tianshu.plugin.json'), 'utf8'))
  assert.equal(manifest.$tpi, '1.0')
  assert.equal(manifest.kind, 'tianshu.plugin')
  assert.match(manifest.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  assert.ok(manifest.displayName.length > 0 && manifest.displayName.length <= 64)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(manifest.description.length <= 500)
  assert.equal(manifest.runtime, 'agent')
  assert.ok(manifest.engines.tianshu)
})
