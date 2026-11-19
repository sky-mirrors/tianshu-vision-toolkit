/**
 * 读图前的路径守卫。
 *
 * 宿主的 pathParams 守卫只处理字符串参数（数组会被整体跳过），而 `vision_glance`
 * 收的是 `images: string[]`，且图片字节会被 base64 后发给外部视觉端点——所以这里
 * 必须自己拦一次：拒绝把凭据/密钥文件当图片读入并发出去。
 */
import { basename } from 'node:path'

const SENSITIVE_NAME = [
  /^\.env(\.|$)/i,
  /credentials/i,
  /private.*key/i,
  /\btoken\b/i,
  /\.pem$/i,
  /id_rsa/i,
  /\.key$/i,
  /secret/i,
]

export function assertReadableImagePath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('image path must be a non-empty string')
  }
  const name = basename(path)
  if (SENSITIVE_NAME.some(pattern => pattern.test(name))) {
    throw new Error(`refusing to read ${name}: credential-like files must not be sent as images`)
  }
  return path
}
