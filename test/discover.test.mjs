/**
 * 天枢 provider 自动发现：让用户不必手填一套 VISION_*，而是复用天枢里已配好的视觉模型。
 *
 * 关键前提（已核实）：`<rivetHome>/provider-keys.json` 里存的是加密块，插件读不懂，
 * 所以只按 `apiKeyEnv` 从 process.env 取密钥；拿不到就不猜，转而告诉用户缺哪个环境变量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverTianshuVisionProvider, listVisionCandidates, rivetHomeFromDataDir } from '../lib/vision/discover.js'
import { resolveVisionConfig } from '../lib/vision/config.js'

function rivetHome(providers) {
  const home = mkdtempSync(join(tmpdir(), 'rivet-home-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ provider: { default: 'x', providers } }, null, 2))
  mkdirSync(join(home, 'plugin-data', 'vision-toolkit'), { recursive: true })
  return { home, dataDir: join(home, 'plugin-data', 'vision-toolkit') }
}

test('rivetHomeFromDataDir 从 plugin-data/<id>/ 上跳两级', () => {
  assert.equal(rivetHomeFromDataDir(join(tmpdir(), 'r', '.rivet', 'plugin-data', 'vision-toolkit')),
    join(tmpdir(), 'r', '.rivet'))
  assert.equal(rivetHomeFromDataDir(undefined), undefined)
})

test('发现第一个「有视觉模型 + 有 baseUrl + 取得到密钥」的 provider', () => {
  const { home, dataDir } = rivetHome({
    kimi: { baseUrl: 'https://api.kimi.com/coding/v1', protocol: 'openai', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'k3', supportsVision: true }] },
  })
  try {
    const found = discoverTianshuVisionProvider({ dataDir, env: { KIMI_API_KEY: 'sk-test' } })
    assert.ok(found, '应发现 kimi')
    assert.equal(found.baseUrl, 'https://api.kimi.com/coding/v1')
    assert.equal(found.model, 'k3')
    assert.equal(found.protocol, 'chat_completions')
    assert.equal(found.apiKey, 'sk-test')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有视觉模型 / 没有 baseUrl / 没有密钥 的 provider 一律跳过', () => {
  const { home, dataDir } = rivetHome({
    textOnly: { baseUrl: 'https://a', apiKeyEnv: 'A_KEY', models: [{ id: 'm1' }] },
    noBase: { apiKeyEnv: 'B_KEY', models: [{ id: 'm2', supportsVision: true }] },
    noKey: { baseUrl: 'https://c', apiKeyEnv: 'C_KEY', models: [{ id: 'm3', supportsVision: true }] },
    usable: { baseUrl: 'https://d', apiKeyEnv: 'D_KEY', models: [{ id: 'm4', supportsVision: true }] },
  })
  try {
    const found = discoverTianshuVisionProvider({ dataDir, env: { A_KEY: 'a', B_KEY: 'b', D_KEY: 'd' } })
    assert.equal(found?.providerId, 'usable', '只有 usable 三条都满足')

    const candidates = listVisionCandidates({ dataDir, env: { A_KEY: 'a', B_KEY: 'b', D_KEY: 'd' } })
    assert.equal(candidates.length, 3)
    const noKeyRow = candidates.find(row => row.providerId === 'noKey')
    assert.equal(noKeyRow.hasKey, false)
    assert.equal(noKeyRow.keyEnv, 'C_KEY')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('用户显式配置优先于自动发现', () => {
  const { home, dataDir } = rivetHome({
    kimi: { baseUrl: 'https://api.kimi.com/coding/v1', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'k3', supportsVision: true }] },
  })
  try {
    const config = resolveVisionConfig({
      dataDir,
      env: { VISION_BASE_URL: 'https://mine', VISION_API_KEY: 'k', VISION_MODEL: 'm', KIMI_API_KEY: 'from-host' },
    })
    assert.equal(config.baseUrl, 'https://mine')
    assert.equal(config.model, 'm')
    assert.equal(config.source, 'env/config.json')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('什么都没配时自动复用天枢 provider，并在 source 里说明来源', () => {
  const { home, dataDir } = rivetHome({
    kimi: { baseUrl: 'https://api.kimi.com/coding/v1/', protocol: 'openai', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'k3', supportsVision: true }] },
  })
  try {
    const config = resolveVisionConfig({ dataDir, env: { KIMI_API_KEY: 'sk-host' } })
    assert.equal(config.baseUrl, 'https://api.kimi.com/coding/v1', '尾部斜杠要去掉')
    assert.equal(config.model, 'k3')
    assert.equal(config.apiKey, 'sk-host')
    assert.equal(config.protocol, 'chat_completions')
    assert.match(config.source, /Tianshu provider "kimi"/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('发现不了时错误里列出候选与缺的环境变量', () => {
  const { home, dataDir } = rivetHome({
    kimi: { baseUrl: 'https://api.kimi.com/coding/v1', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'k3', supportsVision: true }] },
  })
  try {
    assert.throws(
      () => resolveVisionConfig({ dataDir, env: {} }),
      error => {
        assert.match(error.message, /VISION_BASE_URL/)
        assert.match(error.message, /config\.json/)
        assert.match(error.message, /kimi \/ k3/, '要指出哪个 provider + 模型可用')
        assert.match(error.message, /env KIMI_API_KEY/, '要指出缺哪个环境变量')
        return true
      },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('只给密钥就能用：baseUrl 与 model 由天枢 provider 补齐', () => {
  const { home, dataDir } = rivetHome({
    kimi: { baseUrl: 'https://api.kimi.com/coding/v1', protocol: 'openai', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'k3', supportsVision: true }] },
  })
  try {
    const config = resolveVisionConfig({
      dataDir,
      env: { VISION_API_KEY: 'sk-only-key', KIMI_API_KEY: 'sk-host' },
    })
    assert.equal(config.baseUrl, 'https://api.kimi.com/coding/v1')
    assert.equal(config.model, 'k3')
    assert.equal(config.apiKey, 'sk-only-key', '显式密钥优先于宿主的同环境变量')
    assert.match(config.source, /kimi/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('显式给 model 时不再被发现的模型覆盖', () => {
  const { home, dataDir } = rivetHome({
    kimi: { baseUrl: 'https://api.kimi.com/coding/v1', apiKeyEnv: 'KIMI_API_KEY', models: [{ id: 'k3', supportsVision: true }] },
  })
  try {
    const config = resolveVisionConfig({
      dataDir,
      env: { VISION_MODEL: 'my-vision-model', VISION_API_KEY: 'k', KIMI_API_KEY: 'host-key' },
    })
    assert.equal(config.model, 'my-vision-model')
    assert.equal(config.baseUrl, 'https://api.kimi.com/coding/v1', 'baseUrl 仍可由发现补齐')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 边界：配置缺失 / 损坏 / 字段类型不对 / dataDir 层级不足 ────────────

test('config.json 不存在时不算错误，按「没有可发现的 provider」处理', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-empty-'))
  mkdirSync(join(home, 'plugin-data', 'vision-toolkit'), { recursive: true })
  try {
    const dataDir = join(home, 'plugin-data', 'vision-toolkit')
    assert.equal(discoverTianshuVisionProvider({ dataDir, env: {} }), null)
    assert.deepEqual(listVisionCandidates({ dataDir, env: {} }), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('config.json 损坏时报错而不是静默当作没有 provider', () => {
  const home = mkdtempSync(join(tmpdir(), 'rivet-broken-'))
  mkdirSync(join(home, 'plugin-data', 'vision-toolkit'), { recursive: true })
  writeFileSync(join(home, 'config.json'), '{ broken')
  try {
    const dataDir = join(home, 'plugin-data', 'vision-toolkit')
    assert.throws(() => discoverTianshuVisionProvider({ dataDir, env: {} }), /cannot read .*config\.json/,
      '损坏的配置必须抛错并指出是哪个文件，不能静默当作没有 provider')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('provider 的 models 不是数组、provider 不是对象时都被安全跳过', () => {
  const { home, dataDir } = rivetHome({
    weird1: { baseUrl: 'https://a', apiKeyEnv: 'A_KEY', models: 'not-an-array' },
    weird2: null,
    weird3: { baseUrl: 'https://c', apiKeyEnv: 'C_KEY', models: [{ id: 'm', supportsVision: 'yes' }] },
    ok: { baseUrl: 'https://d', apiKeyEnv: 'D_KEY', models: [{ id: 'real', supportsVision: true }] },
  })
  try {
    const found = discoverTianshuVisionProvider({ dataDir, env: { A_KEY: 'a', C_KEY: 'c', D_KEY: 'd' } })
    assert.equal(found?.providerId, 'ok', 'supportsVision 必须是布尔 true，字符串不算')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('dataDir 层级不足时推导不出 rivetHome，直接返回 null 不抛错', () => {
  assert.equal(discoverTianshuVisionProvider({ dataDir: 'vision-toolkit', env: {} }), null)
  assert.deepEqual(listVisionCandidates({ dataDir: 'vision-toolkit', env: {} }), [])
})
