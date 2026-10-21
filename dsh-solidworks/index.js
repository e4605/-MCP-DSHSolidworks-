// DSH SolidWorks plugin — author: e^46 zhaoyi
import path from 'node:path'
import { runSw } from './lib/bridge.js'
import { checkMcpServer, installMcpServer, mcpRowConfig, resolvePython, SERVER_NAME } from './lib/mcp.js'

export const name = 'dsh-solidworks'
export const inject = ['tools', 'systemPrompt']

// Optional row-config keys (see README): autoLaunch, showWindow, setUnits,
// autoRebuildCheck, connectTimeoutMs, operationTimeoutMs. Defaults are
// applied inside apply(), so no schema package dependency is required.

const DIM_MAX = 10000
const DIM_MIN = 0.01

function numArg(value, label, min, max, unit = 'mm') {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是数字（${unit}）`)
  if (value < min || value > max) throw new Error(`${label}超出允许范围：${min}–${max} ${unit}`)
  return value
}

function oneOf(value, options, label) {
  if (!options.includes(value)) throw new Error(`${label}必须是以下之一：${options.join('/')}`)
  return value
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label}不能为空`)
  return value
}

// The model-facing function schema must be a JSON Schema with type "object";
// a bare property map would reach the provider as "type: null".
function params(properties, required = []) {
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

const NO_PARAMS = { type: 'object', properties: {} }

const SW_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['summary', 'ok', 'report'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    ok: { type: 'boolean' },
    report: { type: 'object', additionalProperties: true },
  },
}

const swOutput = {
  schema: SW_OUTPUT_SCHEMA,
  render: (_args, value) => [{ type: 'text', text: value.summary }],
}

const ERR_MESSAGES = {
  SW_NOT_INSTALLED: ['未检测到已安装的 SolidWorks。', '请安装 SOLIDWORKS 2018 或更高版本。'],
  SW_NOT_RUNNING: ['SolidWorks 尚未启动，且插件配置禁止自动启动。', '请手动打开 SolidWorks，或在插件配置中把 autoLaunch 设为 true。'],
  SW_LAUNCH_FAILED: ['SolidWorks 启动失败。', '请手动打开 SolidWorks 确认授权与许可正常，再重试。'],
  SW_STARTING: ['SolidWorks 正在启动或正忙（可能刚冷启动、正在加载插件或停留在对话框）。', '请等待约 1–2 分钟后重试；若反复出现，请检查 SolidWorks 窗口是否有需要处理的弹窗。'],
  SW_NO_DOC: ['当前没有打开的 SolidWorks 文档。', '先调用 sw_new_part 新建零件，或手动打开一个零件文件。'],
  SW_NO_TEMPLATE: ['未找到默认零件模板。', '在 SolidWorks 中打开「选项 → 系统选项 → 默认模板」，为零件指定默认模板。'],
  SW_NEW_DOC_FAILED: ['新建零件失败。', '请确认 SolidWorks 模板未损坏且授权正常。'],
  SW_NO_PLANES: ['在文档中找不到基准面。', '请用默认零件模板新建文档后重试。'],
  SW_BAD_PARAMS: ['参数无效。', '检查参数是否合法（尺寸为正数、枚举值正确）。'],
  SW_SKETCH_FAILED: ['草图绘制失败。', '检查尺寸与形状参数是否为正数，必要时重新新建零件。'],
  SW_NO_SKETCH: ['没有活动草图可供操作。', '先调用 sw_draw_sketch 绘制草图，再执行本操作。'],
  SW_EXTRUDE_FAILED: ['拉伸失败：草图可能未闭合或几何无效。', '重新绘制封闭轮廓草图（矩形/圆等）后再拉伸。'],
  SW_CUT_UNSUPPORTED: ['当前 SolidWorks 的自动化接口不支持拉伸切除。', '改用组合草图实现孔/槽：先用 sw_draw_sketch 画外形，再用 append=true 追加圆/矩形等内轮廓，最后一次性 sw_extrude 拉伸成型。'],
  SW_FILLET_FAILED: ['倒圆角失败：半径可能大于局部几何允许值。', '减小 radius 重试；圆角半径必须小于最小壁厚。'],
  SW_CHAMFER_UNSUPPORTED: ['当前 SolidWorks 的自动化接口不支持倒斜角。', '改用 sw_fillet 倒圆角，或在 SolidWorks 界面中手动倒斜角。'],
  SW_NO_BODY: ['零件中没有任何实体。', '先拉伸成型出实体后再倒圆角/倒角。'],
  SW_NO_EDGES: ['未能选中任何实体边线。', '确认零件中存在实体。'],
  SW_REVOLVE_CUT_FAILED: ['旋转切除失败：轮廓与旋转轴无效。', '在活动草图中画一个不穿过中心线的封闭轮廓，并用 append=true 追加中心线作为旋转轴。'],
  SW_MATE_FAILED: ['配合创建失败：选点处没有可用的面（可能被遮挡、在实体内部，或选到了错误的实体）。', '把选点放在两个零件的可见面上：同心配合需各选一个圆柱面且未被其他零件挡住。'],
  SW_ASSEMBLY_FAILED: ['装配体操作失败：当前文档不是装配体，或零件路径无法加载。', '先调用 sw_new_assembly 新建装配体，再添加已保存的零件文件。'],
  SW_BAD_PATH: ['无效的保存路径。', '提供绝对路径且以 .sldprt 结尾。'],
  SW_SAVE_FAILED: ['保存失败。', '确认目标目录可写、文件未被其他程序占用。'],
  SW_BAD_ACTION: ['未知的桥接操作。', '请通过 DSH 工具正常调用。'],
}

function unitsLabel(units) {
  if (units === 'MMGS') return '毫米（MMGS）'
  if (units === 'keep') return '保持用户设置'
  return '未确认（不影响建模）'
}

const PLANE_LABELS = { front: '前视基准面', top: '上视基准面', right: '右视基准面' }

function sketchDesc(args) {
  const shape = args.shape
  if (shape === 'rectangle') return `矩形 ${args.width}×${args.height} mm`
  if (shape === 'circle') return `圆 直径 ${args.diameter} mm`
  if (shape === 'polygon') return `正${args.sides ?? 6}边形 外接圆直径 ${args.diameter} mm`
  if (shape === 'arc') return `圆弧 直径 ${args.diameter} mm（${args.start_angle ?? 0}°→${args.end_angle ?? 180}°）`
  if (shape === 'ellipse') return `椭圆 ${args.diameter}×${args.minor} mm`
  if (shape === 'polyline') return `折线（${args.points}）`
  if (shape === 'centerline') return `中心线（${args.points}）`
  return '草图'
}

function featureFailure(what, hint) {
  return `❌ ${what}后模型重建检查失败。建议：${hint}`
}

function buildCheckReport(d) {
  const lines = [`SolidWorks 模型质检报告 —— 「${d.title ?? ''}」`]
  const checks = []
  const icon = (s) => (s === 'pass' ? '✅' : s === 'warn' ? '⚠️' : s === 'fail' ? '❌' : '➖')
  if (d.isAssembly) {
    if (!d.rebuildOk) checks.push(['模型重建', 'fail', '装配体重建失败'])
    else checks.push(['模型重建', 'pass', '装配体重建无错误'])
    checks.push(['实体数量', 'skip', '装配体由组件构成，不统计实体数'])
    if (d.unitsOk) checks.push(['单位系统', 'pass', 'MMGS（毫米/克）'])
    else checks.push(['单位系统', 'warn', '当前单位系统未确认为 MMGS；sw_connect 时通常会自动设置'])
    if (d.savedPath) checks.push(['保存状态', 'pass', d.savedPath])
    else checks.push(['保存状态', 'warn', '装配体尚未保存；用 sw_save 保存为 .SLDASM'])
    for (const [item, status, detail] of checks) lines.push(`${icon(status)} ${item}：${detail}`)
    const hasFail = checks.some((c) => c[1] === 'fail')
    lines.push(hasFail ? '结论：❌ 未通过 —— 装配体重建失败，请检查组件引用。' : '结论：✅ 全部通过 —— 装配体结构正常（组件配合请在 SolidWorks 中确认）。')
    return lines.join('\n')
  }
  if (d.rebuildOk === null || d.rebuildOk === undefined) {
    checks.push(['模型重建', 'skip', '插件配置关闭了自动重建检查'])
  } else if (d.rebuildOk) {
    checks.push(['模型重建', 'pass', 'EditRebuild3 重建无错误'])
  } else {
    checks.push(['模型重建', 'fail', '重建返回失败，存在几何错误'])
  }
  const errs = Array.isArray(d.featureErrors) ? d.featureErrors : []
  if (errs.length > 0) {
    checks.push(['特征错误', 'fail', errs.join('；')])
  } else {
    checks.push(['特征错误', 'pass', `全部 ${d.featureCount ?? 0} 个特征无错误`])
  }
  if (typeof d.bodyCount === 'number' && d.bodyCount > 1) {
    checks.push(['实体数量', 'warn', `当前零件包含 ${d.bodyCount} 个独立实体（多为分体设计；如需单一体请让各部件相互重叠）`])
  } else if (typeof d.bodyCount === 'number') {
    checks.push(['实体数量', 'pass', '单实体'])
  }
  if (d.hasMass && typeof d.mass === 'number') {
    // The bridge reports SI values (kg / m³ / m²); convert to g / mm³ / mm².
    const massG = d.mass * 1000
    const volMm3 = d.volume * 1e9
    const areaMm2 = d.surfaceArea * 1e6
    checks.push(['质量属性', 'pass', `质量 ${massG.toFixed(2)} g，体积 ${volMm3.toFixed(1)} mm³，表面积 ${areaMm2.toFixed(1)} mm²`])
  } else {
    checks.push(['质量属性', 'warn', '无法计算（可能没有实体或模型存在错误）'])
  }
  if (d.unitsOk) checks.push(['单位系统', 'pass', 'MMGS（毫米/克）'])
  else checks.push(['单位系统', 'warn', '当前单位系统未确认为 MMGS；sw_connect 时通常会自动设置'])
  if (d.savedPath) checks.push(['保存状态', 'pass', d.savedPath])
  else checks.push(['保存状态', 'warn', '文档尚未保存；完成建模后用 sw_save 保存为 .sldprt'])
  for (const [item, status, detail] of checks) lines.push(`${icon(status)} ${item}：${detail}`)
  const hasFail = checks.some((c) => c[1] === 'fail')
  const hasWarn = checks.some((c) => c[1] === 'warn')
  if (hasFail) lines.push('结论：❌ 未通过 —— 存在失败项，修复后重新调用 sw_check_quality。')
  else if (hasWarn) lines.push('结论：⚠️ 基本通过 —— 存在警告项，建议处理后再向用户交付。')
  else lines.push('结论：✅ 全部通过 —— 模型质量合格，可保存交付。')
  return lines.join('\n')
}

function summarize(action, args, d) {
  switch (action) {
    case 'connect': {
      const launchNote = d.launched ? '已自动启动 SolidWorks' : '已连接运行中的实例'
      const doc = d.activeDocTitle ? `当前文档：${d.activeDocTitle}` : '当前文档：（无）'
      return `✅ ${launchNote}。版本：${d.version || '未知'}。窗口可见：${d.visible}。单位系统：${unitsLabel(d.units)}。${doc}。下一步：sw_new_part 新建零件。`
    }
    case 'new_part':
      return `✅ 已新建零件「${d.title ?? ''}」。单位系统：${unitsLabel(d.units)}。下一步：sw_draw_sketch 绘制草图，再用 sw_extrude 拉伸成型。`
    case 'draw_sketch': {
      const appendNote = args.append ? '（追加到当前草图）' : ''
      return `✅ 已在${PLANE_LABELS[args.plane ?? 'front'] ?? '基准面'}绘制${sketchDesc(args)}草图${appendNote}（以原点为中心）。草图保持编辑状态；下一步调用 sw_extrude 拉伸或 sw_cut 切除。`
    }
    case 'extrude': {
      if (d.clean === false) return featureFailure('拉伸', '检查草图是否封闭/自相交；如新特征报错，删除后重新绘制草图。')
      const dir = args.direction === 'reverse' ? '反向' : args.direction === 'midplane' ? '两侧对称' : '正向'
      const extra = [args.draft ? `锥度 ${args.draft}°` : '', args.start ? `起始偏移 ${args.start} mm` : ''].filter(Boolean).join('，')
      return `✅ 拉伸凸台完成：深度 ${args.depth} mm，方向 ${dir}${extra ? `，${extra}` : ''}；重建正常，特征总数 ${d.featureCount ?? '未知'}。`
    }
    case 'cut': {
      if (d.clean === false) return featureFailure('切除', '检查草图与切除方向。')
      return `✅ 拉伸切除完成：${args.through_all ? '完全贯穿' : `深度 ${args.depth} mm`}；重建正常。`
    }
    case 'fillet': {
      if (d.clean === false) return `❌ 圆角后模型重建检查失败（半径 ${args.radius} mm 可能过大）。建议：减小 radius 后重试。`
      return `✅ 倒圆角完成：半径 ${args.radius} mm，作用于 ${d.edgeCount ?? 0} 条实体边线；重建正常。`
    }
    case 'chamfer': {
      if (d.clean === false) return `❌ 倒角后模型重建检查失败（距离 ${args.distance} mm 可能过大）。建议：减小 distance 后重试。`
      return `✅ 倒斜角完成：距离 ${args.distance} mm × ${args.angle ?? 45}°；重建正常。`
    }
    case 'save':
      return `✅ 已保存：${d.path}（${((d.sizeBytes ?? 0) / 1024).toFixed(1)} KB）。建议调用 sw_check_quality 做最终质检。`
    case 'revolve_cut': {
      if (d.clean === false) return featureFailure('旋转切除', '确认轮廓不穿过中心线，且中心线已追加到同一草图。')
      return `✅ 旋转切除完成（${args.angle ?? 360}°）；重建正常，特征总数 ${d.featureCount ?? '未知'}。`
    }
    case 'new_assembly':
      return `✅ 已新建装配体「${d.title ?? ''}」。下一步：用 sw_add_component 插入已保存的零件（.sldprt）。`
    case 'add_component':
      return `✅ 已插入组件：${d.path}（位置 ${d.x}, ${d.y}, ${d.z} mm，旋转 ${d.angle ?? 0}°）。继续插入其它零件，最后用 sw_save 保存为 .SLDASM。`
    case 'add_mate': {
      const label = args.type === 'concentric' ? '同心（铰链）' : '重合'
      return `✅ 已添加${label}配合（当前配合数 ${d.mateCount ?? 1}）。组件已被约束连接。`
    }
    case 'check':
      return buildCheckReport(d)
    default:
      return 'SolidWorks 操作完成。'
  }
}

const HELP_TEXT = `# SolidWorks 建模指南（新手友好）

## 标准工作流
1. sw_connect —— 连接/启动 SolidWorks（每次会话第一次建模前必做）
2. sw_new_part —— 新建空白零件
3. sw_draw_sketch —— 在基准面绘制草图（矩形/圆/多边形/圆弧/椭圆/折线/中心线，单位毫米）
4. sw_extrude —— 拉伸成实体（可加锥度、起始偏移；merge=false 生成工具实体）
5. sw_revolve_cut —— 旋转切除挖去实体（轮廓 + 中心线，可做通孔/环形槽）
6. sw_fillet —— 倒圆角修饰
7. sw_check_quality —— 质量检查（全部通过才算完成）
8. sw_save —— 保存为 .SLDPRT

## 装配体
1. sw_new_assembly —— 新建装配体
2. sw_add_component —— 插入已保存的零件（可指定 x/y/z 位置）
3. sw_add_mate —— 同心（铰链）/重合配合
4. sw_save —— 保存为 .SLDASM

## MCP 连接（本插件内置）
- 连接声明在 cordis.patch.yml 的 solidworks-mcp 行（@deepseek-ai/dsh-mcp-client，stdio）。
- 实际服务器：Python 包 solidworks-mcp，命令 python -m solidworks_mcp.server。
- 连接异常时先调用 sw_mcp_check（install=true 可自动 pip 安装后复检）。
- MCP 工具名形如 mcp__solidworks__<tool>（86 个，首选）。

## 要点
- 所有尺寸单位为毫米；草图默认以原点为中心。
- 一次只保留一个活动草图：画完草图立即拉伸/切除。
- 开孔三种方式：① 先画外形，再用 append=true 追加内轮廓，一次拉伸成型；② 贴轴矩形 + 中心线 + sw_revolve_cut 旋转切除出通孔；③ 环形槽用旋转切除分段角度。
- 某些 SolidWorks 版本不支持直接拉伸切除/斜角/布尔，本机请用旋转切除或内轮廓方案。
- 任何建模任务结束前必须调用 sw_check_quality，报告全绿后才能向用户宣布完成，并给出保存路径。

## 示例提示词
- 「画一个长 100、宽 60、高 20 的平板，四条竖边倒 R5 圆角，保存到 D:\\parts\\plate.sldprt」
- 「做一个直径 40、高 50 的圆锥形灯罩」
- 「用两个零件拼一个装配体并保存为 D:\\parts\\demo.sldasm」`

function callText(toolName, args) {
  switch (toolName) {
    case 'sw_connect': return '连接 SolidWorks 并统一单位为毫米'
    case 'sw_new_part': return '新建空白零件'
    case 'sw_draw_sketch': return `绘制草图：${args.shape} @ ${args.plane ?? 'front'}`
    case 'sw_extrude': return `拉伸凸台：深度 ${args.depth} mm`
    case 'sw_cut': return `拉伸切除：${args.through_all ? '完全贯穿' : `深度 ${args.depth} mm`}`
    case 'sw_fillet': return `倒圆角：半径 ${args.radius} mm`
    case 'sw_chamfer': return `倒斜角：距离 ${args.distance} mm × ${args.angle ?? 45}°`
    case 'sw_boolean': return `布尔运算：${args.operation ?? 'subtract'}`
    case 'sw_revolve_cut': return `旋转切除：${args.angle ?? 360}°`
    case 'sw_new_assembly': return '新建装配体'
    case 'sw_add_component': return `插入组件：${args.path}`
    case 'sw_add_mate': return `添加配合：${args.type ?? 'coincident'}`
    case 'sw_save': return `保存零件：${args.path}`
    case 'sw_check_quality': return '执行模型质量检查'
    default: return toolName
  }
}

function makeSwTool(toolName, title, description, parameters, action, validate, timeoutMs, pluginConfig) {
  return {
    name: toolName,
    description,
    parameters,
    output: swOutput,
    timeoutMs,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      if (validate) validate(input)
      const out = await runSw(action, input, pluginConfig, timeoutMs, exec.signal)
      if (!out || out.ok !== true) {
        const [message, fix] = ERR_MESSAGES[out?.code] ?? ['SolidWorks 操作失败。', '']
        const detail = typeof out?.detail === 'string' && out.detail ? `（详情：${out.detail}）` : ''
        return {
          summary: `❌ ${message}${detail}${fix ? ` 建议：${fix}` : ''}`,
          ok: false,
          report: { errorCode: out?.code ?? 'UNKNOWN', errorMessage: out?.detail ?? '' },
        }
      }
      const data = out.data && typeof out.data === 'object' ? out.data : {}
      return { summary: summarize(action, input, data), ok: true, report: data }
    },
    presentCall: (args) => {
      const input = args && typeof args === 'object' ? args : {}
      return {
        card: 'generic',
        title: `SolidWorks · ${title}`,
        kind: 'execute',
        rawInput: input,
        content: [{ type: 'text', text: callText(toolName, input) }],
      }
    },
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'SolidWorks · 操作失败' : 'SolidWorks · 操作结果',
      content: result.content,
    }),
  }
}

export function apply(ctx, config = {}) {
  const cfg = (key, fallback) => config[key] ?? fallback
  const make = (...args) => makeSwTool(...args, config)

  const tools = [
    {
      name: 'sw_help',
      description: 'SolidWorks 建模使用指南：查看工作流程、工具清单、要点和示例提示词。当不知道如何开始 SolidWorks 建模时先调用它。',
      parameters: NO_PARAMS,
      output: swOutput,
      timeoutMs: 30000,
      async execute() {
        return { summary: HELP_TEXT, ok: true, report: {} }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'SolidWorks · 使用指南',
        kind: 'execute',
        content: [{ type: 'text', text: '查看 SolidWorks 建模指南' }],
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        title: 'SolidWorks · 使用指南',
        content: result.content,
      }),
    },
    make('sw_connect', '连接 SolidWorks', '连接本机 SolidWorks：优先附加到已运行的实例；未运行且插件配置允许时自动启动并显示窗口。连接时把单位统一为毫米（MMGS）。每次会话第一次建模前先调用。', NO_PARAMS, 'connect', null, cfg('connectTimeoutMs', 300000)),
    make('sw_new_part', '新建零件', '在 SolidWorks 中新建一个空白零件文档（默认零件模板，单位毫米）。开始一个新模型时先调用它。', NO_PARAMS, 'new_part', null, cfg('operationTimeoutMs', 180000)),
    make('sw_draw_sketch', '绘制草图', '在指定基准面上绘制二维草图：rectangle（矩形，需 width/height）、circle（圆，需 diameter）、polygon（正多边形，需 sides/diameter）、arc（圆弧，需 diameter/start_angle/end_angle）、ellipse（椭圆，需 diameter 长轴、minor 短轴）、polyline（折线，需 points="x1,y1;x2,y2;..."）、centerline（中心线，需 points 两个点，用于后续旋转轴）。尺寸单位为毫米，默认以原点为中心，可用 center_x/center_y 偏移。绘制后草图保持编辑状态，必须接着调用 sw_extrude 拉伸或 sw_cut 切除；一次只保留一个活动草图。append=true 时把新轮廓追加到当前活动草图（用于开孔/开槽：先画外形，再追加内轮廓，一次拉伸成型）。', params({
      plane: { type: 'string', enum: ['front', 'top', 'right'], description: '草图所在基准面，默认 front（前视）。append=true 时忽略。' },
      shape: { type: 'string', enum: ['rectangle', 'circle', 'polygon', 'arc', 'ellipse', 'polyline', 'centerline'], description: '草图形状。' },
      width: { type: 'number', description: '矩形宽度（mm），shape=rectangle 时必填。' },
      height: { type: 'number', description: '矩形高度（mm），shape=rectangle 时必填。' },
      diameter: { type: 'number', description: '圆直径、多边形外接圆直径、圆弧半径×2、或椭圆长轴直径（mm）。' },
      minor: { type: 'number', description: '椭圆短轴直径（mm），shape=ellipse 时必填。' },
      sides: { type: 'integer', description: '多边形边数（3–64），shape=polygon 时使用，默认 6。' },
      center_x: { type: 'number', description: '草图中心 X 偏移（mm），默认 0。' },
      center_y: { type: 'number', description: '草图中心 Y 偏移（mm），默认 0。' },
      append: { type: 'boolean', description: 'true 时把轮廓追加到当前活动草图（多轮廓开孔），默认 false。' },
      points: { type: 'string', description: '折线/中心线的点串，格式 "x1,y1;x2,y2;..."（mm），shape=polyline/centerline 时必填。' },
      start_angle: { type: 'number', description: '圆弧起始角（度），shape=arc 时使用，默认 0。' },
      end_angle: { type: 'number', description: '圆弧终止角（度），shape=arc 时使用，默认 180。' },
    }), 'draw_sketch', (a) => {
      oneOf(a.plane ?? 'front', ['front', 'top', 'right'], 'plane')
      oneOf(a.shape, ['rectangle', 'circle', 'polygon', 'arc', 'ellipse', 'polyline', 'centerline'], 'shape')
      if (a.shape === 'rectangle') {
        numArg(a.width, 'width', DIM_MIN, DIM_MAX)
        numArg(a.height, 'height', DIM_MIN, DIM_MAX)
      } else if (a.shape === 'circle' || a.shape === 'arc') {
        numArg(a.diameter, 'diameter', DIM_MIN, DIM_MAX)
      } else if (a.shape === 'ellipse') {
        numArg(a.diameter, 'diameter', DIM_MIN, DIM_MAX)
        numArg(a.minor, 'minor', DIM_MIN, DIM_MAX)
      } else if (a.shape === 'polygon') {
        if (!Number.isInteger(a.sides) || a.sides < 3 || a.sides > 64) throw new Error('sides 必须是 3–64 的整数')
        numArg(a.diameter, 'diameter', DIM_MIN, DIM_MAX)
      } else if (a.shape === 'polyline' || a.shape === 'centerline') {
        requireString(a.points, 'points')
      }
      if (a.shape === 'arc') {
        numArg(a.start_angle ?? 0, 'start_angle', -360, 360, '°')
        numArg(a.end_angle ?? 180, 'end_angle', -360, 360, '°')
      }
      if (a.center_x !== undefined) numArg(a.center_x, 'center_x', -DIM_MAX, DIM_MAX)
      if (a.center_y !== undefined) numArg(a.center_y, 'center_y', -DIM_MAX, DIM_MAX)
    }, cfg('operationTimeoutMs', 180000)),
    make('sw_extrude', '拉伸凸台', '把当前活动草图拉伸成实体（凸台）。拉伸前必须先 sw_draw_sketch。depth 单位毫米；direction：forward 沿草图法向、reverse 反向、midplane 两侧对称拉伸（总深度=depth）。draft：锥度角（度），正值远端收窄、负值远端张开（如 15 做锥形灯罩/收口杯体），默认 0。start：从草图平面沿法向偏移的起始距离（mm），用于把实体叠放在不同高度，默认 0。merge=false 时生成独立实体（作为布尔挖去的工具实体），默认 true 合并。', params({
      depth: { type: 'number', description: '拉伸深度（mm）。' },
      direction: { type: 'string', enum: ['forward', 'reverse', 'midplane'], description: '拉伸方向，默认 forward。' },
      draft: { type: 'number', description: '锥度角（度），-45~45，正值远端收窄、负值远端张开，默认 0。' },
      start: { type: 'number', description: '起始偏移（mm），0~2000，沿草图法向从草图平面开始，默认 0。' },
      merge: { type: 'boolean', description: '是否与已有实体合并，默认 true；false 时生成独立工具实体供布尔挖去除。' },
    }, ['depth']), 'extrude', (a) => {
      numArg(a.depth, 'depth', DIM_MIN, DIM_MAX)
      oneOf(a.direction ?? 'forward', ['forward', 'reverse', 'midplane'], 'direction')
      if (a.draft !== undefined) numArg(a.draft, 'draft', -45, 45, '°')
      if (a.start !== undefined) numArg(a.start, 'start', 0, 2000)
    }, cfg('operationTimeoutMs', 180000)),
    make('sw_cut', '拉伸切除', '用当前活动草图切除材料（拉伸切除）。through_all=true 时完全贯穿，否则切除 depth 深度；切割方向垂直于草图平面（direction：forward/reverse）。注意：部分 SolidWorks 版本不支持此操作，会提示改用组合草图（sw_draw_sketch append=true 追加内轮廓后一次拉伸成型）。', params({
      depth: { type: 'number', description: '切除深度（mm）；through_all=true 时忽略。' },
      through_all: { type: 'boolean', description: '是否完全贯穿，默认 false。' },
      direction: { type: 'string', enum: ['forward', 'reverse'], description: '切除方向，默认 forward。' },
    }), 'cut', (a) => {
      if (a.through_all !== true) numArg(a.depth, 'depth', DIM_MIN, DIM_MAX)
      oneOf(a.direction ?? 'forward', ['forward', 'reverse'], 'direction')
    }, cfg('operationTimeoutMs', 180000)),
    make('sw_revolve_cut', '旋转切除（挖去实体）', '用当前活动草图做旋转切除：把封闭轮廓绕草图内中心线旋转一定角度，从实体中挖去材料。用法：先 sw_draw_sketch 画封闭轮廓（如矩形），再用 append=true 追加一条中心线（旋转轴），最后调用本工具。适合做通孔、阶梯孔、环形槽、开口缺口等。注意：轮廓不应穿过中心线；圆柱类通孔可画「贴轴矩形」旋转 360°。', params({
      angle: { type: 'number', description: '旋转角度（度），默认 360，范围 1–360。' },
    }), 'revolve_cut', (a) => {
      numArg(a.angle ?? 360, 'angle', 1, 360, '°')
    }, cfg('operationTimeoutMs', 180000)),
    make('sw_fillet', '倒圆角', '对零件所有实体边线倒圆角。radius 单位毫米，必须小于最小壁厚；失败时按提示减小半径重试。', params({
      radius: { type: 'number', description: '圆角半径（mm），0.01–500。' },
    }, ['radius']), 'fillet', (a) => {
      numArg(a.radius, 'radius', 0.01, 500)
    }, cfg('operationTimeoutMs', 180000)),
    make('sw_chamfer', '倒斜角', '对零件所有实体边线倒 45° 斜角（距离-角度方式）。distance 单位毫米。注意：部分 SolidWorks 版本不支持此操作，会提示改用圆角或手动倒角。', params({
      distance: { type: 'number', description: '斜角距离（mm），0.01–500。' },
      angle: { type: 'number', description: '斜角角度（度），5–89，默认 45。' },
    }, ['distance']), 'chamfer', (a) => {
      numArg(a.distance, 'distance', 0.01, 500)
      numArg(a.angle ?? 45, 'angle', 5, 89, '°')
    }, cfg('operationTimeoutMs', 180000)),
    make('sw_save', '保存零件/装配体', '把当前文档保存为 .SLDPRT（零件）或 .SLDASM（装配体）。path 必须是绝对路径；目录不存在时自动创建。保存前建议先 sw_check_quality。', params({
      path: { type: 'string', description: '保存的绝对路径，例如 D:\\parts\\box.sldprt 或 D:\\parts\\asm.sldasm。' },
    }, ['path']), 'save', (a) => {
      const p = requireString(a.path, 'path')
      if (!path.isAbsolute(p)) throw new Error('path 必须是绝对路径（如 D:\\parts\\box.sldprt）')
      if (!p.toLowerCase().endsWith('.sldprt') && !p.toLowerCase().endsWith('.sldasm')) throw new Error('path 必须以 .sldprt 或 .sldasm 结尾')
    }, cfg('operationTimeoutMs', 180000)),
    make('sw_new_assembly', '新建装配体', '新建一个空白装配体文档（.SLDASM，默认装配体模板，单位毫米）。随后用 sw_add_component 插入已保存的零件文件。', NO_PARAMS, 'new_assembly', null, cfg('operationTimeoutMs', 180000)),
    make('sw_add_component', '插入装配组件', '把已保存的零件（.SLDPRT）插入当前装配体，放在指定坐标（x/y/z，mm），可绕 Z 轴旋转指定角度（angle，度）—— 这样可以把斜臂、灯罩等组件摆成任意姿态，实现"可活动"的装配效果。组件之间不做配合约束（浮动定位），可在 SolidWorks 中再补充配合。', params({
      path: { type: 'string', description: '零件文件绝对路径（.sldprt），例如 D:\\parts\\base.sldprt。' },
      x: { type: 'number', description: '插入位置 X（mm），默认 0。' },
      y: { type: 'number', description: '插入位置 Y（mm），默认 0。' },
      z: { type: 'number', description: '插入位置 Z（mm），默认 0。' },
      angle: { type: 'number', description: '绕 Z 轴旋转角度（度），0~360，默认 0。' },
    }, ['path']), 'add_component', (a) => {
      const p = requireString(a.path, 'path')
      if (!path.isAbsolute(p)) throw new Error('path 必须是绝对路径（如 D:\\parts\\base.sldprt）')
      if (!p.toLowerCase().endsWith('.sldprt')) throw new Error('path 必须以 .sldprt 结尾（装配体只能插入零件）')
      if (a.angle !== undefined) numArg(a.angle, 'angle', -360, 360, '°')
    }, cfg('operationTimeoutMs', 180000)),
    make('sw_add_mate', '添加配合约束', '在装配体中对两个面添加配合：coincident（两面重合）或 concentric（同心 —— 用于转轴/铰链，可绕轴自由旋转）。用两个精确坐标点（mm）指定要选中的面，点必须落在可见面上且未被其他零件遮挡。配合后组件被真正约束连接，不再是"摆在一起"。', params({
      type: { type: 'string', enum: ['coincident', 'concentric'], description: '配合类型：coincident 重合、concentric 同心（铰链）。' },
      x1: { type: 'number', description: '第一个面的选点 X（mm）。' },
      y1: { type: 'number', description: '第一个面的选点 Y（mm）。' },
      z1: { type: 'number', description: '第一个面的选点 Z（mm）。' },
      x2: { type: 'number', description: '第二个面的选点 X（mm）。' },
      y2: { type: 'number', description: '第二个面的选点 Y（mm）。' },
      z2: { type: 'number', description: '第二个面的选点 Z（mm）。' },
    }, ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']), 'add_mate', (a) => {
      oneOf(a.type ?? 'coincident', ['coincident', 'concentric'], 'type')
      for (const k of ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']) numArg(a[k], k, -DIM_MAX, DIM_MAX)
    }, cfg('operationTimeoutMs', 180000)),
    make('sw_check_quality', '质量检查', '对当前零件执行质量检查：重建模型、扫描全部特征错误、计算质量/体积/表面积/重心、核对单位系统与保存状态，输出质检报告。任何建模任务完成前必须调用；报告中所有检查项通过后才能向用户宣布完成。', NO_PARAMS, 'check', null, cfg('operationTimeoutMs', 180000)),
    {
      name: 'sw_mcp_check',
      description: '检查并修复 SolidWorks MCP 连接：核对接入配置（cordis.patch.yml 的 solidworks-mcp 行 → @deepseek-ai/dsh-mcp-client，stdio），确认 Python 运行时能导入内置 MCP 服务器模块（solidworks_mcp.server）。install=true 时自动 pip 安装 solidworks-mcp 包后复检。MCP 工具（mcp__solidworks__*）不出现或连接异常时先调用本工具。',
      parameters: params({
        install: { type: 'boolean', description: 'true 时自动执行 pip install solidworks-mcp 后再复检，默认 false。' },
        python: { type: 'string', description: '可选：Python 解释器绝对路径（默认用 DSH 运行时自带 Python）。' },
      }),
      output: swOutput,
      timeoutMs: 360000,
      async execute(input) {
        const args = input && typeof input === 'object' ? input : {}
        const python = resolvePython({ pythonPath: args.python })
        const row = mcpRowConfig(python)
        const first = await checkMcpServer(python)
        let installed = null
        let final = first
        if (!first.ok && args.install === true) {
          installed = await installMcpServer(python)
          final = await checkMcpServer(python)
        }
        const lines = [
          `SolidWorks MCP 连接自检 —— ${final.ok ? '✅ 服务器可用' : '❌ 服务器不可用'}`,
          '接入声明：cordis.patch.yml → id: solidworks-mcp → @deepseek-ai/dsh-mcp-client',
          `serverName：${row.serverName}（工具名形如 mcp__${row.serverName}__<tool>）`,
          `transport：${row.transport}　command：${row.command}`,
          `args：${row.args.join(' ')}`,
          `Python 导入检查：${first.ok ? '成功' : '失败'}${first.detail ? `（${first.detail}）` : ''}`,
        ]
        if (installed) {
          lines.push(`自动安装：${installed.ok ? '成功' : `失败（exit ${installed.code}）`}${installed.detail ? ` — ${installed.detail}` : ''}`)
        }
        if (!final.ok) {
          lines.push('修复：再次调用 sw_mcp_check 并设 install=true，或手动执行：')
          lines.push(`  "${python}" -m pip install solidworks-mcp`)
        } else {
          lines.push(`下一步：用 mcp__${row.serverName}__get_status 验证；若 MCP 工具尚未出现，重载插件（set_bundle enabled:false → true）。`)
        }
        return { summary: lines.join('\n'), ok: final.ok, report: { ok: final.ok, python, row, first, installed, final } }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'SolidWorks · MCP 连接自检',
        kind: 'execute',
        content: [{ type: 'text', text: '检查 MCP 接入配置与服务器可用性' }],
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        title: 'SolidWorks · MCP 连接自检',
        content: result.content,
      }),
    },
  ]

  for (const tool of tools) ctx.tools.register(tool)

  ctx.systemPrompt.section({
    name: 'tool:solidworks',
    order: 1050,
    text: `SolidWorks 建模（本插件已内置 SolidWorks MCP 服务器）：
1) 首选 MCP 工具 mcp__solidworks__*（86 个：建模、挖孔、螺纹、配合、运动检查、截图、导出）。每次建模调用都返回体积/质量/包围盒，必须与手算核对，不一致先修正。
2) sw_* 是轻量备用工具（15 个 = 14 个直连 COM + sw_mcp_check 连接自检）：sw_connect → sw_new_part → sw_draw_sketch → sw_extrude → sw_cut/sw_revolve_cut → sw_fillet → sw_check_quality → sw_save。
3) 单位一律毫米。先 get_status（或 sw_connect）确认 SolidWorks 已运行；新建零件用 new_part / sw_new_part，装配体用 new_assembly / sw_new_assembly。
4) 装配体：insert_component 定位 → set_component_transform 旋转 → add_mate（concentric 即铰链）→ check_interference 证明无干涉。
5) 任何建模任务完成前必须质检：MCP 调用自带重建校验，sw_* 用 sw_check_quality；全部通过后才能宣布完成，并报告保存的完整路径（装配体另附截图）。
6) MCP 连接由 cordis.patch.yml 的 solidworks-mcp 行完成（@deepseek-ai/dsh-mcp-client，stdio：python -m solidworks_mcp.server）；连接异常时用 sw_mcp_check（install=true 自动安装服务器包）。
7) 已知小坑：add_disc 或新零件的第一个特征偶发失败时重试一次即可；几何不要贴原点（x、y 不能为 0）。`,
  })
}
