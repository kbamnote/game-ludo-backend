import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zipSync } from 'fflate'

test('MetaPerson generation, duplicate submission, export download and room serialization', async t => {
  const root = await mkdtemp(join(tmpdir(),'ludo-mp-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  process.env.AVATAR_DATA_DIR = root
  process.env.METAPERSON_DAILY_LIMIT = '1'
  delete process.env.METAPERSON_CLIENT_SECRET
  const { serveMetaPerson } = await import('../dist/metaperson.js')
  const { readCharacter } = await import('../dist/room.js')
  const server = createServer(serveMetaPerson)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const request = fetch
  const base = 'http://127.0.0.1:'+server.address().port+'/avatars/metaperson/'
  assert.equal((await request(base+'styles?body=male')).status,503)
  process.env.METAPERSON_CLIENT_ID='test-only'
  process.env.METAPERSON_CLIENT_SECRET='test-only'
  const code = '00394f02-7c60-4292-8591-33789e2d0fed'
  const model = Buffer.alloc(32)
  model.write('glTF'); model.writeUInt32LE(2,4); model.writeUInt32LE(model.length,8)
  let created=0, completed=false
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    const {host,pathname} = new URL(url)
    assert.equal(host,'api.avatarsdk.com')
    if (pathname==='/o/token/') return Response.json({access_token:'test',expires_in:36000})
    assert.equal(init.headers.Authorization,'Bearer test')
    if (pathname.startsWith('/export_parameters/')) return Response.json({outfits:{list:['test-outfit']}})
    if (pathname==='/avatars/') {
      created++
      assert.equal(init.body.get('pipeline'),'metaperson_2.1')
      assert.equal(JSON.parse(init.body.get('export_parameters')).outfits.list[0],'test-outfit')
      return Response.json({code})
    }
    if (pathname.endsWith('/exports/')) return Response.json([{status:'Completed',code}])
    if (pathname.endsWith('/file/')) return new Response(zipSync({'avatar/model.glb':model}))
    return Response.json({status:completed?'Completed':'Computing',progress:42})
  })
  const upload=photo=>request(base+'generate?body=male&outfit=test-outfit',{method:'POST',body:photo})
  const photo=Buffer.from([255,216,255,217])
  const jobs=await Promise.all([upload(photo),upload(photo)])
  assert.deepEqual(jobs.map(r=>r.status),[202,202])
  const [{id},duplicate]=await Promise.all(jobs.map(r=>r.json()))
  assert.equal(id,duplicate.id);assert.equal(created,1)
  assert.deepEqual(await (await request(base+id)).json(),{ready:false,progress:42})
  completed=true
  assert.deepEqual(await (await request(base+id)).json(),{ready:true,progress:100})
  assert.deepEqual(Buffer.from(await (await request(base+id+'.glb')).arrayBuffer()),model)
  assert.equal((await upload(Buffer.from([255,216,0,0,255,217]))).status,429)
  assert.deepEqual(readCharacter({model:4,avatarId:id}),{model:4,avatarId:id})
  assert.equal(readCharacter({model:4,avatarId:'https://other.example/model.glb'}),undefined)
})
