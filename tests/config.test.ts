import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError, FACTORY_CONFIG, configSchema, loadConfig } from '../src/server/config.js'

const factoryModels = {
  primary: { model: 'deepseek-v4-pro-0813' },
  background: { model: 'deepseek-v4-flash-0731' },
  vision: { model: 'qwen3.8-flash' },
  embedding: { model: 'bge-m3', dimensions: 1024 },
}

describe('配置校验（fail-fast）', () => {
  it('出厂默认通过并补全默认值', () => {
    const c = configSchema.parse({ models: factoryModels })
    expect(c.server.port).toBe(3000)
    expect(c.briefing.schedule).toBe('08:00')
    expect(c.models.embedding.dimensions).toBe(1024)
  })

  it('未知顶层键 → 报错且指出键名', () => {
    expect(() => configSchema.parse({ models: factoryModels, hackr: 1 })).toThrowError(/hackr/)
  })

  it('未知嵌套键 → 报错且指出键名', () => {
    expect(() =>
      configSchema.parse({ models: { ...factoryModels, primary: { model: 'x', typ0: 1 } } }),
    ).toThrowError(/typ0/)
  })

  it('非法 schedule → 报错', () => {
    expect(() =>
      configSchema.parse({ models: factoryModels, briefing: { schedule: '25:00' } }),
    ).toThrowError(/HH:mm/)
  })
})

describe('loadConfig', () => {
  it('无 config.json → 完整走出厂默认', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-cfg-'))
    const { config, configPath } = loadConfig(dir)
    expect(configPath).toBeNull()
    expect(config.models.primary.model).toBe('deepseek-v4-pro-0813')
    expect(config).toEqual(FACTORY_CONFIG)
  })

  it('config.json 部分覆盖 → 与出厂默认深合并', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-cfg-'))
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ models: { primary: { model: 'test-primary' } } }),
    )
    const { config, configPath } = loadConfig(dir)
    expect(configPath).not.toBeNull()
    expect(config.models.primary.model).toBe('test-primary')
    expect(config.models.background.model).toBe('deepseek-v4-flash-0731')
    expect(config.server.port).toBe(3000)
  })

  it('config.json 含未知键 → ConfigError 指出键名', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-cfg-'))
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ models: factoryModels, typoKey: true }),
    )
    expect(() => loadConfig(dir)).toThrow(ConfigError)
    expect(() => loadConfig(dir)).toThrowError(/typoKey/)
  })

  it('config.json 非法 JSON → ConfigError', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-cfg-'))
    fs.writeFileSync(path.join(dir, 'config.json'), '{oops')
    expect(() => loadConfig(dir)).toThrow(ConfigError)
  })
})
