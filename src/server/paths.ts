import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 数据目录解析：显式环境变量 > Docker 约定 /data > 用户主目录 ~/.cortxt */
export function resolveDataDir(): string {
  const fromEnv = process.env.CORTEXT_DATA_DIR?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  if (process.env.CORTEXT_IS_DOCKER === '1' || fs.existsSync('/.dockerenv')) return '/data'
  return path.join(os.homedir(), '.cortxt')
}

export interface DirLayout {
  dataDir: string
  dbPath: string
  vaultDir: string
  configPath: string
}

export function dirLayout(dataDir: string): DirLayout {
  return {
    dataDir,
    dbPath: path.join(dataDir, 'cortxt.db'),
    vaultDir: path.join(dataDir, 'vault'),
    configPath: path.join(dataDir, 'config.json'),
  }
}
