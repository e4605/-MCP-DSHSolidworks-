**# -MCP-DSHSolidworks-
Deepseek Harness SW插件，可以通过MCP调用SW的各种技能
# SolidWorks 建模插件（DSH）

> 作者：**e^46 zhaoyi**

让 DSH 直接驱动本机 SolidWorks：**15 个轻量 `sw_*` 工具 + 内置 86 工具 SolidWorks MCP 服务器（`mcp__solidworks__*`）**，每次建模自带体积/质量校验，完成前强制质检。

## 安装

1. **装 MCP 服务器依赖**（一次性，需要网络）：

   ```
   "C:\Users\<用户名>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" -m pip install solidworks-mcp
   ```

2. **打开 SolidWorks** 并保持运行（插件连接已运行实例，不负责启动它）。
3. **安装本插件**：`plugin_manager install_bundle` 指向本目录；已安装则重载（`set_bundle enabled:false` → `true`）。

## 两组工具
| 组 | 数量 | 说明 |
| --- | --- | --- |
| `mcp__solidworks__*` | 86 | 完整能力：盒/盘/柱/锥/任意轮廓、旋转/放样/扫掠、孔与沉孔、ISO 螺纹、圆角倒角抽壳、阵列镜像筋、平面、文字、材料、装配配合与运动检查、干涉检查、测量、截图、STEP/STL/3MF 导出、打印检查、工程图、特征编辑 |
| `sw_*` | 15 | 轻量直连 COM：连接、新建、草图（矩形/圆/多边形/弧/椭圆/折线/中心线）、拉伸（锥度/偏移）、切除、旋转切除、圆角、倒角、质检、保存、装配体、插入组件、配合，外加 `sw_mcp_check` 连接自检 |

**首选 MCP 工具**；`sw_*` 作为无 MCP 时的备用。

## MCP 连接在哪（代码位置）

| 位置 | 内容 |
| --- | --- |
| [`cordis.patch.yml`](cordis.patch.yml#L7-L16) | **连接声明**：`id: solidworks-mcp` → `@deepseek-ai/dsh-mcp-client`，配置 serverName / transport: stdio / command / args / failOnStartupError |
| [`lib/mcp.js`](lib/mcp.js) | **连接的落地代码**：解析 Python 运行时、检查 `solidworks_mcp.server` 可导入、可执行 `pip install solidworks-mcp`、生成与补丁完全一致的连接配置 |
| [`index.js`](index.js) 的 `sw_mcp_check` | **诊断工具**：一键核对接入配置 + 服务器可用性，`install=true` 自动补装服务器包 |

> MCP 客户端本身由 DSH 提供（`@deepseek-ai/dsh-mcp-client`），插件负责「声明连接 + 检查/修复服务器端」，无需也不应把客户端代码复制进来。

## 推荐流程

1. `mcp__solidworks__get_status` 或 `sw_connect` 确认已连接 SolidWorks。
2. 建模：`new_part` → `add_*`（每步核对返回的体积）→ `save_part`。
3. 装配：`new_assembly` → `insert_component` → `set_component_transform` → `add_mate`（concentric 即铰链）→ `check_interference` → `save_assembly`。
4. 收尾：`screenshot` 看图确认 + 质检通过后报告完整保存路径。

## 要求与已知限制

- Windows + 已安装并运行的 SolidWorks；Python 3.11+（用 DSH 自带运行时）。
- 单位一律毫米；使用标准 Y-up 零件模板。
- 小坑：`add_disc` 或新零件**第一个**特征偶发失败 —— 重试一次即可；几何不要贴原点（x、y 不能为 0）。
- `sw_*` 限制：本机不支持直接拉伸切除/斜角/布尔（用「追加内轮廓 + 拉伸」或旋转切除替代）；配合仅 concentric/coincident；保存会先删同名旧文件，目标被其他文档占用时会报错提示。

## 卸载

`plugin_manager remove_bundle`，或 `set_bundle enabled:false` 临时停用。

---

© 2026 **e^46 zhaoyi** · 本插件的全部代码、文档与图标均由 e^46 zhaoyi 署名。
