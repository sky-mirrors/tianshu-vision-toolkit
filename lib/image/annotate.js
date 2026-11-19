/**
 * 在 RGBA 光栅上画标注框（预览图用）。
 *
 * 只做一件事：把框的四条边涂成实线。越界坐标先钳制——视觉模型给的 0-1000 网格
 * 换算过来偶尔会越界 1-2 像素，不钳制会写出界。
 */
const RED = [230, 30, 30]

/** @param {{ width:number, height:number, data:Uint8ClampedArray }} rgba 会被原地修改 */
export function drawBox(rgba, box, thickness = 2) {
  const { width, height, data } = rgba
  const x1 = Math.max(0, Math.min(width - 1, box.x1))
  const y1 = Math.max(0, Math.min(height - 1, box.y1))
  const x2 = Math.max(0, Math.min(width - 1, box.x2))
  const y2 = Math.max(0, Math.min(height - 1, box.y2))
  const paint = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const index = (y * width + x) * 4
    data[index] = RED[0]
    data[index + 1] = RED[1]
    data[index + 2] = RED[2]
    data[index + 3] = 255
  }
  for (let t = 0; t < thickness; t += 1) {
    for (let x = x1; x <= x2; x += 1) {
      paint(x, y1 + t)
      paint(x, y2 - t)
    }
    for (let y = y1; y <= y2; y += 1) {
      paint(x1 + t, y)
      paint(x2 - t, y)
    }
  }
  return rgba
}
