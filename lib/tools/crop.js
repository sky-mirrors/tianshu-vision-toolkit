/**
 * vision_crop：把像素框裁出来存成 PNG，可选放大。
 *
 * 语义对齐上游 `bin/crop`：region 两端点任意顺序，越界 clamp 到图像边界，
 * 放大用 Lanczos，默认输出在原图旁 `<stem>.crop[@Nx].png`。
 */
import { writeFileSync } from 'node:fs'
import { loadRgb } from '../image.js'
import { cropRegion, parseRegion, resizeRgb } from '../raster.js'
import { encodePng } from '../png.js'
import { artifactName, resolveOutput } from '../artifacts.js'

function defaultName(imagePath, scale) {
  return artifactName(imagePath, scale > 1 ? `.crop@${scale}x.png` : '.crop.png')
}

function rgbaFromRgb(rgb) {
  const data = new Uint8ClampedArray(rgb.width * rgb.height * 4)
  for (let i = 0, n = rgb.width * rgb.height; i < n; i += 1) {
    data[i * 4] = rgb.data[i * 3]
    data[i * 4 + 1] = rgb.data[i * 3 + 1]
    data[i * 4 + 2] = rgb.data[i * 3 + 2]
    data[i * 4 + 3] = 255
  }
  return { width: rgb.width, height: rgb.height, data }
}

export const cropTool = {
  name: 'vision_crop',
  description:
    'Cut a pixel box out of an image into its own PNG artifact, locally, without a vision credential. '
    + 'The box is clamped to the image bounds; use scale 2-4 to enlarge small icons before reading them.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      image: { type: 'string', description: 'Image path (PNG).' },
      region: { type: 'string', description: 'Pixel box to cut out as X1,Y1,X2,Y2 (pixels); clamped to the image bounds.' },
      scale: { type: 'integer', description: 'Upscale factor 1-8 (Lanczos3); default 1.' },
      output: { type: 'string', description: 'Output PNG path; defaults to <cwd>/.rivet/artifacts/vision/<image-stem>.crop.png.' },
    },
    required: ['image', 'region'],
  },
  pathParams: { image: 'read', output: 'write' },
  concurrencySafe: true,
  timeoutMs: 60000,
  async execute(call) {
    const args = call.args
    const scale = args.scale === undefined ? 1 : args.scale
    if (!Number.isInteger(scale) || scale < 1 || scale > 8) {
      return { content: 'vision_crop: scale must be an integer 1-8', isError: true }
    }

    const source = loadRgb(args.image)
    const box = parseRegion(args.region, source.width, source.height)
    const cropped = cropRegion(source, box)
    const scaled = scale > 1 ? resizeRgb(cropped, cropped.width * scale, cropped.height * scale) : cropped

    const outputPath = resolveOutput(args.output, call.cwd, defaultName(args.image, scale))
    writeFileSync(outputPath, encodePng(rgbaFromRgb(scaled)))

    const report = {
      imageWidth: source.width,
      imageHeight: source.height,
      region: { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 },
      outputPath,
      mimeType: 'image/png',
      width: scaled.width,
      height: scaled.height,
      clamped: box.clamped,
      ...(box.clamped ? { note: `region ${args.region} clamped to ${box.x1},${box.y1},${box.x2},${box.y2}` } : {}),
    }
    return { content: JSON.stringify(report, null, 2) }
  },
}
