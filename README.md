# Tianshu Vision Toolkit

给天枢（Tianshu Harness）用的视觉工具箱插件。纯 JavaScript、零第三方依赖：不引 Python、
不装原生模块、不需要构建步骤——把目录放进插件目录就能跑。

## 它解决什么问题

纯文本模型看不见图。这个插件提供 10 个工具，让「看图」这件事从"模型猜"变成"工具测"：

| 工具 | 作用 | 需要视觉密钥 |
|---|---|---|
| `vision_glance` | 描述/问答/OCR/多图比较 | ✅ |
| `vision_ground` | 定位一个点名目标，返回像素框 | ✅ |
| `vision_detect` | 清点某一类元素的全部实例 | ✅ |
| `vision_long_screenshot_ocr` | 长截图分块 OCR 并合并 | ✅ |
| `vision_crop` | 按像素框裁切并 Lanczos 放大 | ❌ |
| `vision_pixel_diff` | 逐像素比对 + 最差区域排序 + 热力图 | ❌ |
| `vision_dominant_colors` | 区域显著色测量 / 候选色裁定 | ❌ |
| `vision_extract_foreground` | 连通分量抠图，输出透明 PNG | ❌ |
| `vision_trace` | 位图 → SVG（像素边界环 + RDP 简化） | ❌ |
| `vision_html_screenshot` | 本地 HTML 渲染截图，支持 fullPage | ❌ |

**不需要密钥的 6 个工具装完即可用**，这是本插件相对上游改编的主要取向：能本地算的一律本地算。

## 安装

天枢插件目录（按你的安装方式选一个）：

```
<rivetHome>/plugins/vision-toolkit/
```

或直接用命令行跑，不经过宿主（排障与无宿主时可用）：

```bash
node scripts/vision.mjs list
node scripts/vision.mjs doctor          # 看凭据状态与可复用的天枢 provider
node scripts/vision.mjs crop --image a.png --region 0,0,200,120 --scale 2
node scripts/vision.mjs diff --original a.png --rebuilt b.png --grid 6
node scripts/vision.mjs colors --image a.png --candidates "#F5F5F5,#EDEDED"
node scripts/vision.mjs glance --images a.png --query "这段报错说了什么"
```

## 配置视觉端点

**优先复用天枢已有的 provider**：插件读 `<rivetHome>/config.json` 里 `supportsVision: true`
的模型，baseUrl / model / protocol 全自动，你只需要给密钥：

```jsonc
// <rivetHome>/plugin-data/vision-toolkit/config.json
{ "apiKey": "sk-xxx" }
```

或走环境变量：`VISION_BASE_URL` / `VISION_API_KEY` / `VISION_MODEL`
（可选 `VISION_API_PROTOCOL` = `chat_completions` | `responses` | `anthropic`、
`VISION_BOX_ORDER` = `xyxy` | `yxyx`、`VISION_BROWSER_PATH`）。

`node scripts/vision.mjs doctor` 会列出天枢里所有声明了视觉模型的 provider，以及各自缺哪个环境变量。

## 产物

默认写入 `<cwd>/.rivet/artifacts/vision/`，与天枢把会话/知识/计划放在 `.rivet/` 的约定一致。

## 借鉴与致谢

本插件是以下两个 MIT 许可项目的**独立 JS 重实现**，不含其源代码：

| 项目 | 借鉴内容 |
|---|---|
| Anionex/dsh-vision-toolkit | 10 个工具的名称、参数语义与提示词结构；`vision_skill` 的方法论框架 |
| Anionex/agent-vision-toolkit | 算法语义：region 钳制、白底合成、601-2 亮度差、中位切分量化 + Chebyshev 合并、候选色评分、8 邻域连通分量、行能量切点 |

两者的版权归 Anionex，许可证见其仓库根目录；本项目保留相同的 MIT 许可与派生声明，
详见 `NOTICE`。凡是与上游不一致的地方（算法实现不同、缺少的能力），都在文档中显式标注。

## 与上游的已知差异

| 项 | 差异 |
|---|---|
| `vision_trace` | 单色剪影，无色彩分层（上游用 vtracer） |
| JPEG 输入 | 仅 `vision_glance` 可直接发 JPEG；像素类工具只解 PNG，遇到 JPEG 明确报错并指路 |
| 大图 | 长边 > 1568 自动等比压缩，报告 `analyzedWidth/Height`，`box` 始终是原图坐标 |
| 模型变体 / 粘贴接管 / Settings 面板 | 不做——那是 DSH 宿主机制，天枢无对应接缝 |
| 长截图 OCR | 无 `resume` 断点续跑 |

## 开发

```bash
node --test test/*.test.mjs   # 87 条用例（发布仓库内位于 test/）
node scripts/smoke.mjs               # 模拟宿主装配，跑通 10 个工具
node scripts/pack.mjs --publisher-id <id>   # 按 XiaoSi 插件库格式打发行包
node scripts/verify-pack.mjs dist/*.zip     # 自校验包与摘要表
```

## 许可

MIT。见 `LICENSE` 与 `NOTICE`。
