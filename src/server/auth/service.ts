import { randomBytes } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import type { DB } from '../db.js'

export const SESSION_COOKIE = 'cortxt_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type LoginResult =
  | { ok: true; token: string; maxAgeSec: number }
  | { ok: false; error: string }

export type ChangeResult = { ok: true } | { ok: false; error: string }

export async function hashPassword(password: string): Promise<string> {
  return hash(password)
}

export function hasPassword(db: DB): boolean {
  return !!db.prepare('SELECT id FROM user_auth WHERE id = 1').get()
}

/**
 * DESIGN §8 密码生命周期：首次启动从 .env 的 APP_PASSWORD 种子，
 * 此后以 DB 为准（库中已有密码时 .env 被忽略）。
 */
export async function seedPasswordFromEnv(db: DB): Promise<'seeded' | 'already' | 'no-env'> {
  if (hasPassword(db)) return 'already'
  const pw = process.env.APP_PASSWORD?.trim()
  if (!pw) return 'no-env'
  db.prepare('INSERT INTO user_auth(id, password_hash) VALUES (1, ?)').run(await hashPassword(pw))
  return 'seeded'
}

export async function login(db: DB, password: string): Promise<LoginResult> {
  const row = db.prepare('SELECT password_hash FROM user_auth WHERE id = 1').get() as
    | { password_hash: string }
    | undefined
  if (!row) return { ok: false, error: '尚未设置密码：请先在 .env 配置 APP_PASSWORD 后重启 daemon' }
  const ok = await verify(row.password_hash, password).catch(() => false)
  if (!ok) return { ok: false, error: '密码错误' }
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO app_sessions(token, expires_at) VALUES (?, ?)').run(
    token,
    new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  )
  return { ok: true, token, maxAgeSec: SESSION_TTL_MS / 1000 }
}

export function authedToken(db: DB, token: string | undefined): boolean {
  if (!token) return false
  return !!db
    .prepare('SELECT token FROM app_sessions WHERE token = ? AND expires_at > ?')
    .get(token, new Date().toISOString())
}

export function logout(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM app_sessions WHERE token = ?').run(token)
}

export function purgeExpiredSessions(db: DB): void {
  db.prepare('DELETE FROM app_sessions WHERE expires_at <= ?').run(new Date().toISOString())
}

export async function changePassword(
  db: DB,
  current: string,
  next: string,
): Promise<ChangeResult> {
  const row = db.prepare('SELECT password_hash FROM user_auth WHERE id = 1').get() as
    | { password_hash: string }
    | undefined
  if (!row) return { ok: false, error: '尚未设置密码' }
  const ok = await verify(row.password_hash, current).catch(() => false)
  if (!ok) return { ok: false, error: '当前密码错误' }
  if (next.length < 8) return { ok: false, error: '新密码至少 8 位' }
  db.prepare("UPDATE user_auth SET password_hash = ?, updated_at = datetime('now') WHERE id = 1").run(
    await hashPassword(next),
  )
  // 密码轮换后踢掉全部旧会话（安全默认）
  db.prepare('DELETE FROM app_sessions').run()
  return { ok: true }
}
