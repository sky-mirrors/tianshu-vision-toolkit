/**
 * 统一的调用级超时：宿主不会替插件掐表，工具自己必须能被打断。
 *
 * 实现放在注册处（index.js），一次包住全部工具——而不是每个工具各写一份 race，
 * 那样漏一个就等于没有。
 */
export const TIMEOUT_PARAMETER = {
  timeoutMs: {
    type: 'integer',
    description: 'Per-call timeout in milliseconds; omit to use the tool default.',
  },
}

export function raceTimeout(promise, timeoutMs, toolName) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return promise
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${toolName}: timed out after ${timeoutMs}ms`)), timeoutMs)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 给工具的 inputSchema 补上 timeoutMs 属性（已在清单里声明的不重复加）。 */
export function withTimeoutParameter(tool) {
  const properties = tool.inputSchema?.properties ?? {}
  if (properties.timeoutMs) return tool
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema, properties: { ...properties, ...TIMEOUT_PARAMETER } },
  }
}
