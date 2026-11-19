/**
 * 送模型前的图像准备：长边超过上限就等比缩小。
 *
 * 上游把「超大图自动压缩」放在插件里做，因为模型端点对尺寸有限制；
 * 天枢这边没有宿主管线代劳，所以必须自己压，并把「被分析的那一份」的尺寸如实报出来，
 * 否则调用方会把原图坐标套到压缩图上，框全错位。
 */
import { resizeRgb } from '../raster.js'

/** 视觉模型常见的长边上限；超过就压到这个尺寸。 */
export const MAX_MODEL_SIDE = 1568

/**
 * RGB 光栅 → 不透明 RGBA（编码 PNG 用）。
 * @param {{ width:number, height:number, data:Uint8ClampedArray }} rgb
 */
export function rgbaOf(rgb) {
  const data = new Uint8ClampedArray(rgb.width * rgb.height * 4)
  for (let i = 0, n = rgb.width * rgb.height; i < n; i += 1) {
    data[i * 4] = rgb.data[i * 3]
    data[i * 4 + 1] = rgb.data[i * 3 + 1]
    data[i * 4 + 2] = rgb.data[i * 3 + 2]
    data[i * 4 + 3] = 255
  }
  return { width: rgb.width, height: rgb.height, data }
}

/**
 * @param {{ width:number, height:number, data:Uint8ClampedArray }} raster RGB 光栅
 * @returns {{ width:number, height:number, data:Uint8ClampedArray, compressed:boolean,
 *             originalWidth:number, originalHeight:number }}
 */
export function prepareForModel(raster) {
  const { width, height } = raster
  const longest = Math.max(width, height)
  if (longest <= MAX_MODEL_SIDE) {
    return { ...raster, compressed: false, originalWidth: width, originalHeight: height }
  }
  const scale = MAX_MODEL_SIDE / longest
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const resized = resizeRgb(raster, targetWidth, targetHeight)
  return {
    width: resized.width,
    height: resized.height,
    data: resized.data,
    compressed: true,
    originalWidth: width,
    originalHeight: height,
  }
}
