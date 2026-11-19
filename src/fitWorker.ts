import { parentPort } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import * as face from 'face-api.js'

const weights = fileURLToPath(new URL('../assets/face-landmarks/', import.meta.url))
const ready = Promise.all([
  face.nets.faceLandmark68TinyNet.loadFromDisk(weights),
  face.nets.tinyFaceDetector.loadFromDisk(weights),
])

parentPort?.on('message', async (crop: string) => {
  let image: ReturnType<typeof face.tf.tensor3d> | undefined
  try {
    await ready
    image = face.tf.tensor3d(new Uint8Array(Buffer.from(crop, 'base64')), [64, 64, 3], 'int32')
    const detections = await face.detectAllFaces(image, new face.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: .25 }))
    if (detections.length !== 1) return parentPort?.postMessage({ error: 'Center one well-lit, front-facing face in the oval.' })
    // The player already aligned the crop. Keep points in its coordinate space so
    // the client can use the same locations for both mesh fitting and texture UVs.
    const marks = await face.nets.faceLandmark68TinyNet.detectLandmarks(image)
    if (Array.isArray(marks)) throw Error('Unexpected landmark batch')
    const coords = marks.positions.flatMap(p => [p.x, p.y])
    if (!coords.every(Number.isFinite)) throw Error('Invalid landmarks')
    parentPort?.postMessage({ fit: Buffer.from(coords.map(v => Math.round(Math.max(0, Math.min(1, v / 64)) * 255))).toString('base64') })
  } catch {
    parentPort?.postMessage({ error: 'Could not fit this portrait. Try a clearer selfie.' })
  } finally { image?.dispose() }
})
