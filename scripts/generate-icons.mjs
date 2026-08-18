// Gera assets/icon.ico e assets/icon.png a partir de assets/icon-source.svg.
// Rodar com: node scripts/generate-icons.mjs
import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const svgPath = path.join(root, 'assets', 'icon-source.svg')
const svg = readFileSync(svgPath)

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function buildIco(pngBuffers) {
  // ICO container: header + directory entries + raw PNG data (suportado desde Vista).
  const count = pngBuffers.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  const chunks = [header, dir]

  pngBuffers.forEach(({ size, buffer }, i) => {
    const entry = i * 16
    const dim = size >= 256 ? 0 : size // 0 significa 256 no formato ICO
    dir.writeUInt8(dim, entry + 0) // width
    dir.writeUInt8(dim, entry + 1) // height
    dir.writeUInt8(0, entry + 2) // color palette
    dir.writeUInt8(0, entry + 3) // reserved
    dir.writeUInt16LE(1, entry + 4) // color planes
    dir.writeUInt16LE(32, entry + 6) // bits per pixel
    dir.writeUInt32LE(buffer.length, entry + 8) // size of image data
    dir.writeUInt32LE(offset, entry + 12) // offset
    offset += buffer.length
    chunks.push(buffer)
  })

  return Buffer.concat(chunks)
}

// ICNS: container simples com chunks PNG (formato moderno suportado desde Mac OS X 10.7).
const ICNS_TYPES = [
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
]

async function buildIcns() {
  const chunks = []
  for (const { type, size } of ICNS_TYPES) {
    const png = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()
    const chunkHeader = Buffer.alloc(8)
    chunkHeader.write(type, 0, 'ascii')
    chunkHeader.writeUInt32BE(8 + png.length, 4)
    chunks.push(chunkHeader, png)
  }
  const body = Buffer.concat(chunks)
  const fileHeader = Buffer.alloc(8)
  fileHeader.write('icns', 0, 'ascii')
  fileHeader.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([fileHeader, body])
}

async function main() {
  const pngBuffers = await Promise.all(
    ICO_SIZES.map(async (size) => ({
      size,
      buffer: await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer(),
    }))
  )

  const ico = buildIco(pngBuffers)
  writeFileSync(path.join(root, 'assets', 'icon.ico'), ico)
  console.log('assets/icon.ico gerado (' + ICO_SIZES.join(', ') + 'px)')

  const png512 = await sharp(svg, { density: 384 }).resize(512, 512).png().toBuffer()
  writeFileSync(path.join(root, 'assets', 'icon.png'), png512)
  console.log('assets/icon.png gerado (512px)')

  const icns = await buildIcns()
  writeFileSync(path.join(root, 'assets', 'icon.icns'), icns)
  console.log('assets/icon.icns gerado (' + ICNS_TYPES.map((t) => t.size).join(', ') + 'px)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
