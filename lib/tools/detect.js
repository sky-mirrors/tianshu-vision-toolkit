/**
 * vision_detect：清点某一类元素，带编号返回像素框，可选产出编号带框的预览图。
 *
 * 与 vision_ground 的区别是意图：ground 找一个点名目标，detect 枚举一类的全部实例。
 * 标签里要求带准确可见文字，否则清点结果对 UI 还原没有用处。
 */
import { DEFAULT_CATEGORY, buildCategoryTarget, locateImage, positionOf } from './location.js'
import { writePreview } from './ground.js'

export function createDetectTool(getConfig) {
  return {
    name: 'vision_detect',
    description:
      'Inventory every element of a kind and return numbered pixel boxes in the original image coordinates. '
      + 'Pass a category such as buttons or input fields; set preview=true for a labelled PNG.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: 'Image path.' },
        category: { type: 'string', description: `Element category, e.g. buttons or icons; default: ${DEFAULT_CATEGORY}.` },
        region: { type: 'string', description: 'Inventory only this pixel box X1,Y1,X2,Y2; output stays in image coordinates.' },
        preview: { type: 'boolean', description: 'Generate a numbered bounding-box PNG artifact.' },
        previewOutput: { type: 'string', description: 'Optional preview filename; relative paths resolve under cwd.' },
      },
      required: ['image'],
    },
    pathParams: { image: 'read', previewOutput: 'write' },
    concurrencySafe: args => args?.preview !== true,
    timeoutMs: 180000,
    async execute(call) {
      const args = call.args
      const target = buildCategoryTarget(args.category)
      const { matches, imageWidth, imageHeight, analyzedWidth, analyzedHeight, compressed } = await locateImage(
        { config: getConfig(), timeoutMs: args.timeoutMs, signal: call.signal },
        args.image,
        target,
        args.region,
      )

      const elements = matches.map((match, index) => ({
        index: index + 1,
        label: match.label,
        box: match.box,
        position: positionOf(match.box, imageWidth, imageHeight),
      }))
      const preview = args.preview === true && matches.length > 0
        ? writePreview(args, call.cwd, matches)
        : undefined

      return {
        content: JSON.stringify({
          category: target,
          imageWidth,
          imageHeight,
          analyzedWidth,
          analyzedHeight,
          compressed,
          elementCount: elements.length,
          elements,
          ...(elements.length === 0 ? { note: 'no elements detected for this category' } : {}),
          ...(preview === undefined ? {} : { preview }),
        }, null, 2),
        ...(preview === undefined ? {} : { rawPath: preview.path }),
      }
    },
  }
}
