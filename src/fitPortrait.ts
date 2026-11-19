import type { IncomingMessage, ServerResponse } from 'node:http'
import { Worker } from 'node:worker_threads'

let worker: Worker | undefined
let fitting = false

export async function fitPortrait(req: IncomingMessage, res: ServerResponse) {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  if (fitting) return reply(429, { error: 'Another avatar is being fitted. Try again in a moment.' })
  let crop = ''
  try {
    for await (const chunk of req) {
      crop += chunk.toString('utf8')
      if (crop.length > 16384) return reply(413, { error: 'Face crop is too large.' })
    }
    if (crop.length !== 16384 || !/^[A-Za-z0-9+/]+$/.test(crop)) return reply(400, { error: 'Invalid face crop.' })
  } catch { return reply(400, { error: 'Incomplete face crop.' }) }
  if (fitting) return reply(429, { error: 'Try again in a moment.' })
  fitting = true
  try {
    worker ??= new Worker(new URL('./fitWorker.js', import.meta.url))
    const current = worker
    const result = await new Promise<{ fit?: string; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('Fit timed out')) }, 20000)
      function cleanup() { clearTimeout(timer); current.off('message', done); current.off('error', fail); current.off('exit', fail) }
      function done(value: { fit?: string; error?: string }) { cleanup(); resolve(value) }
      function fail() { cleanup(); reject(Error('Fitter unavailable')) }
      current.once('message', done).once('error', fail).once('exit', fail)
      current.postMessage(crop)
    })
    reply(result.fit ? 200 : 422, result)
  } catch {
    void worker?.terminate()
    worker = undefined
    reply(503, { error: 'The character fitter is unavailable. Please try again.' })
  } finally { fitting = false }
}
