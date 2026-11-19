import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { unzipSync } from 'fflate'

const api = 'https://api.avatarsdk.com'
const pipeline = 'metaperson_2.1'
const root = process.env.AVATAR_DATA_DIR || './avatar-data'
const maxModel = 30 * 1024 * 1024
const key = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
class Problem extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const disabled = () => new Problem(503, 'Selfie generation is awaiting MetaPerson setup on this game server.')
const inFlight = new Map<string, Promise<unknown>>()
function once<T>(id: string, work: () => Promise<T>): Promise<T> {
  const current = inFlight.get(id)
  if (current) return current as Promise<T>
  const next = work().finally(() => inFlight.delete(id))
  inFlight.set(id, next)
  return next
}
let token = '', expires = 0
async function provider(path: string, form?: FormData) {
  const { METAPERSON_CLIENT_ID: id, METAPERSON_CLIENT_SECRET: secret } = process.env
  if (!id || !secret) throw disabled()
  if (Date.now() >= expires) await once('login', async () => {
    const body = new FormData()
    body.set('grant_type', 'client_credentials')
    const r = await fetch(api + '/o/token/', { method: 'POST', body,
      headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64') },
      signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw disabled()
    const result = await r.json()
    if (typeof result.access_token !== 'string') throw disabled()
    token = result.access_token
    expires = Date.now() + Math.max(0, Number(result.expires_in) - 60) * 1000
  })
  const r = await fetch(api + path, { method: form ? 'POST' : 'GET', body: form,
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(45000) })
  if (r.status === 401) expires = 0
  if (r.status === 402 || r.status === 403) throw new Problem(503, 'This server needs MetaPerson API access to generate avatars.')
  if (!r.ok) throw new Problem(r.status === 429 ? 429 : 502, 'MetaPerson could not complete this request. Please try again.')
  return r
}

const wardrobes = new Map<string, string[]>()
async function outfits(body: string) {
  if (body !== 'male' && body !== 'female') throw new Problem(400, 'Choose a body style.')
  if (!wardrobes.has(body)) await once('styles-'+body, async () => {
    const data = await (await provider('/export_parameters/available/'+pipeline+'/?pipeline_subtype='+body)).json()
    const list = data.outfits?.list
    if (!Array.isArray(list) || !list.length) throw new Problem(502, 'MetaPerson did not return any outfits.')
    wardrobes.set(body, list.filter((x: unknown) => typeof x === 'string').slice(0,6))
  })
  return wardrobes.get(body)!
}

async function reserveGeneration() {
  const limit = Number(process.env.METAPERSON_DAILY_LIMIT ?? 3)
  const day = join(root,'quota',new Date().toISOString().slice(0,10))
  await mkdir(day, { recursive: true })
  for (let i = 0; i < Math.min(limit,10000); i++) {
    try { await writeFile(join(day,String(i)), '', { flag: 'wx' }); return }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  }
  throw new Problem(429, 'This game server has reached its daily avatar generation limit.')
}
async function exists(path: string) {
  try { await stat(path); return true }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
async function generate(req: IncomingMessage, body: string, outfit: string) {
  if (!(await outfits(body)).includes(outfit)) throw new Problem(400,'Choose an available outfit.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 3*1024*1024) throw new Problem(413,'Please choose a smaller photo.')
    chunks.push(Buffer.from(chunk))
  }
  const photo = Buffer.concat(chunks)
  if (photo.length < 4 || photo.readUInt16BE(0) !== 0xffd8) throw new Problem(400,'Choose a JPEG portrait.')
  const id = createHmac('sha256',process.env.METAPERSON_CLIENT_SECRET!).update(JSON.stringify([pipeline,body,outfit])).update(photo).digest('hex')
  await once('create-'+id,async () => {
    const record = join(root,id+'.job')
    if (await exists(record) || await exists(join(root,id+'.glb'))) return
    await reserveGeneration()
    const form = new FormData()
    form.set('pipeline',pipeline)
    form.set('pipeline_subtype',body)
    form.set('name','Ludo avatar')
    form.set('photo',new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }),'selfie.jpg')
    form.set('export_parameters',JSON.stringify({
      format:'glb', lod:'LOD2', embed:true, finalize:true,
      textures:{ list:['Color','Normal','GltfMetallicRoughness','BodyVisibilityMask','HeadVisibilityMask'], embed:true, profile:'1K.jpg' },
      avatar:{ list:['AvatarBody','AvatarHead','AvatarEyelashes','AvatarLeftEyeball','AvatarRightEyeball','AvatarTeethLower','AvatarTeethUpper'] },
      haircuts:{ list:['HaircutGenerated'] }, outfits:{ list:[outfit] },
    }))
    const result = await (await provider('/avatars/',form)).json()
    if (!uuid.test(result.code)) throw new Problem(502,'MetaPerson did not return a generation ID.')
    const tmp = record + '.' + randomUUID()
    await writeFile(tmp,result.code); await rename(tmp,record)
  })
  return { id }
}
async function status(id: string) {
  const model = join(root,id+'.glb')
  if (await exists(model)) return { ready:true, progress:100 }
  const record = join(root,id+'.job')
  if (!(await exists(record))) throw new Problem(404,'Avatar not found.')
  const code = await readFile(record,'utf8')
  if (!uuid.test(code)) throw new Error('Invalid saved job')
  const base = '/avatars/'+code+'/'
  const job = await (await provider(base)).json()
  const failed = () => new Problem(422,'MetaPerson could not generate this avatar. Try a well-lit, front-facing photo.')
  if (job.status === 'Failed') throw failed()
  if (job.status !== 'Completed') return { ready:false, progress:Number(job.progress) || 0 }
  const exports = await (await provider(base+'exports/')).json()
  const ex = exports[0]
  if (ex?.status === 'Failed') throw failed()
  if (ex?.status !== 'Completed') return { ready:false, progress:99 }
  if (!uuid.test(ex.code)) throw new Error('Missing export ID')
  const download = await provider(base+'exports/'+ex.code+'/files/avatar/file/')
  const reader = download.body!.getReader(), chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const {done,value} = await reader.read()
    if (done) break
    size += value.length
    if (size > maxModel) { await reader.cancel(); throw new Error('Export too large') }
    chunks.push(Buffer.from(value))
  }
  const archive = Buffer.concat(chunks)
  let bytes = archive
  if (archive.toString('ascii',0,4) !== 'glTF') {
    let count = 0
    const files = unzipSync(archive,{filter: f => /\.glb$/i.test(f.name) && f.originalSize <= maxModel && ++count === 1})
    const first = Object.values(files)[0]
    if (!first) throw new Error('Missing model')
    bytes = Buffer.from(first)
  }
  if (bytes.length < 28 || bytes.toString('ascii',0,4) !== 'glTF' || bytes.readUInt32LE(4)!==2 || bytes.readUInt32LE(8)!==bytes.length)
    throw new Error('Invalid export')
  const tmp = model + '.' + randomUUID()
  await writeFile(tmp,bytes); await rename(tmp,model)
  return { ready:true, progress:100 }
}
export async function serveMetaPerson(req: IncomingMessage,res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin','*')
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers','Content-Type')
  res.setHeader('Cache-Control','no-store')
  res.setHeader('Content-Type','application/json')
  const url = new URL(req.url!, 'http://localhost')
  const tail = url.pathname.slice('/avatars/metaperson/'.length)
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const body = url.searchParams.get('body') ?? 'male'
    if (req.method === 'GET' && tail === 'styles') { res.end(JSON.stringify({ outfits:await outfits(body) })); return }
    if (req.method === 'POST' && tail === 'generate') {
      const job = await generate(req,body,url.searchParams.get('outfit') ?? '')
      res.writeHead(202); res.end(JSON.stringify(job)); return
    }
    if (req.method === 'GET' && key.test(tail)) { res.end(JSON.stringify(await once('status-'+tail,()=>status(tail)))); return }
    if (req.method === 'GET' && tail.endsWith('.glb') && key.test(tail.slice(0,-4))) {
      const file = join(root,tail)
      if (!(await exists(file))) throw new Problem(404,'Avatar model unavailable.')
      const bytes = await readFile(file)
      res.writeHead(200,{'content-type':'model/gltf-binary','cache-control':'private, max-age=86400'}); res.end(bytes); return
    }
    throw new Problem(404,'Unknown avatar request.')
  } catch (e) {
    res.statusCode = e instanceof Problem ? e.status : 502
    res.end(JSON.stringify({error:e instanceof Problem ? e.message : 'The avatar service could not finish. Please retry.'}))
  }
}
