/**
 * vision_ground：定位一个点名目标，返回像素框与方位，可选产出带框的预览图。
 *
 * 框来自模型在 0-1000 网格上的回答，换算成像素后有 1-2 像素的不确定性——
 * 足以用来裁切、点击、比较位置，不足以当作精确尺寸。大图会被压到长边 1568，
 * 报告里的 analyzedWidth/analyzedHeight 描述被分析的那一份，box 始终是原图坐标。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { decodePng, encodePng } from '../png.js'
import { drawBox } from '../image/annotate.js'
import { artifactName, resolveOutput } from '../artifacts.js'
import { locateImage, positionOf } from './location.js'

/** 在原图上画框并写 PNG，返回产物信息。 */
export function writePreview(args, cwd, matches, fallbackName) {
  const rgba = decodePng(readFileSync(args.image))
  for (const match of matches) drawBox(rgba, match.box)
  const path = resolveOutput(args.previewOutput, cwd, fallbackName ?? artifactName(args.image, '.preview.png'))
  writeFileSync(path, encodePng(rgba))
  return { path, filename: path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) }
}

export function createGroundTool(getConfig) {
  return {
    name: 'vision_ground',
    description:
      'Locate one named target in an image and return pixel boxes in the original image coordinates. '
      + 'Oversized images are compressed to 1568px before analysis; set preview=true for a labelled PNG.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: 'Image path.' },
        target: { type: 'string', description: 'What to locate, described precisely, e.g. "the red submit button".' },
        region: { type: 'string', description: 'Search only this pixel box X1,Y1,X2,Y2; results stay in image coordinates.' },
        preview: { type: 'boolean', description: 'Generate a labelled bounding-box PNG artifact.' },
        previewOutput: { type: 'string', description: 'Optional preview filename; relative paths resolve under cwd.' },
      },
      required: ['image', 'target'],
    },
    pathParams: { image: 'read', previewOutput: 'write' },
    concurrencySafe: true,
    timeoutMs: 180000,
    async execute(call) {
      const args = call.args
      if (typeof args.target !== 'string' || args.target.trim() === '') {
        return { content: 'vision_ground: target must not be empty', isError: true }
      }

      const { matches, imageWidth, imageHeight, analyzedWidth, analyzedHeight, compressed } = await locateImage(
        { config: getConfig(), timeoutMs: args.timeoutMs, signal: call.signal },
        args.image,
        args.target.trim(),
        args.region,
      )

      if (matches.length === 0) {
        return {
          content: JSON.stringify({
            target: args.target,
            imageWidth,
            imageHeight,
            matches: [],
            note: 'no match returned by the vision model; try a more specific target or a region',
          }, null, 2),
        }
      }

      const labeled = matches.map(match => ({
        label: match.label,
        box: match.box,
        position: positionOf(match.box, imageWidth, imageHeight),
      }))
      const preview = args.preview === true ? writePreview(args, call.cwd, matches) : undefined

      return {
        content: JSON.stringify({
          target: args.target,
          imageWidth,
          imageHeight,
          analyzedWidth,
          analyzedHeight,
          compressed,
          matches: labeled,
          ...(preview === undefined ? {} : { preview }),
        }, null, 2),
        ...(preview === undefined ? {} : { rawPath: preview.path }),
      }
    },
  }
}
