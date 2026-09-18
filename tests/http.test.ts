import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/http.js'

describe('http 骨架', () => {
  it('GET /healthz → 200 {ok:true}', async () => {
    const res = await createApp().request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('未知 /api/* → JSON 404（不落 SPA 兜底）', async () => {
    const res = await createApp().request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'not found' })
  })
})
