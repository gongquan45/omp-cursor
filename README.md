# OMP 鼠标编辑浮层插件 (`omp-mouse-edit-overlay`)

为 [Oh-My-Pi (OMP)](https://omp.sh) 草稿提供类似终端文本编辑器的全屏鼠标定位、拖动选择与可视化编辑能力的纯插件扩展。

## 适用背景与方案

由于 OMP 核心的普通终端缓冲区直接由内联输入管理器接管，普通插件无法直接在主输入框内拦截并处理终端鼠标事件。本插件采用 **全屏浮层 (fullscreen overlay)** 方案：
- 按快捷键打开独立的全屏编辑浮层，在独立 alternate screen 下开启 SGR 鼠标报告；
- 提供完整的文本选择、鼠标拖拽、双击选词、三击选行、平滑边缘滚动及独立撤销/重做栈；
- 编辑完成后通过 `Ctrl+Enter` 或 `Ctrl+Q` 保存并写回主输入框草稿；
- 按 `Esc` 丢弃修改，恢复原草稿。

## 快速上手

### 1. 安装与运行方式

- **单次运行**：
  在插件根目录下运行：
  ```bash
  omp -e .
  ```
  或者在任意工作目录通过绝对路径指定扩展：
  ```bash
  omp -e "E:/Desktop/New folder"
  ```
  *(注：无需加 `--no-extensions`，以免禁用你已安装的其它扩展；`--no-extensions` 仅供隔离测试插件时使用)*

- **全局配置文件持久化（推荐，免管理员权限）**：
  在 OMP 主配置文件 `%USERPROFILE%\.omp\agent\config.yml`（对应 `~/.omp/agent/config.yml`）中添加插件绝对路径：
  ```yaml
  extensions:
    - E:/Desktop/New folder
  ```
  *(注：OMP 的全局主配置文件为 `~/.omp/agent/config.yml`，若使用 JSON 格式亦可在同目录 `settings.json` 的 `"extensions"` 数组中配置)*

- **通过目录链接持久化**：
  在 `%USERPROFILE%\.omp\agent\extensions\` 目录下创建目录联接（Junction，无需管理员权限）：
  ```cmd
  mklink /J "%USERPROFILE%\.omp\agent\extensions\omp-mouse-edit-overlay" "E:\Desktop\New folder"
  ```
  或者使用官方插件命令 `omp plugin link "E:/Desktop/New folder"`（在 Windows 下跨盘符创建符号链接需要系统开启“开发者模式”或管理员权限）。
### 2. 交互说明

- **打开浮层**：在主输入框中输入草稿，按 `Alt+E` 即可弹出全屏编辑浮层。
  - *注：在 Windows Terminal 等常见终端中实测 Alt+E 可正常透传；若您使用的终端环境拦截了 Alt+E，可在终端设置中将 Alt 键设为发送转义序列或换用支持 Alt 组合键的终端。*
- **光标定位与双宽字符**：
  - 单击鼠标左键直接移动光标；
  - 自动对齐 Unicode Grapheme 簇边界；
  - 双宽字符（汉字、Emoji 等）点击左半单元格落在字符前边界，点击右半单元格落在字符后边界。
- **拖动选择**：
  - 按住鼠标左键拖动可扩大选区（选区呈现 ANSI 反显高亮）；
  - 拖至顶部或底部边缘时，以 50ms 频率自动滚动并持续扩展选区；
  - 释放鼠标停止拖拽与自动滚动。
- **多击快捷选择**：
  - 500ms 内在同一位置**双击**：自动选词（支持英文、CJK 词组、标点与芯片整体）；
  - 500ms 内在同一位置**三击**：选中整行（含非末行的换行符）。
- **滚轮滚动**：
  - 鼠标滚轮向上/向下滚动，每次移动 3 个视觉行。
- **保存与退出**：
  - **保存并返回主草稿**：按 `Ctrl+Enter` 或 `Ctrl+Q`。
    - *注：Windows Terminal 等终端通常无法发送独立的 Ctrl+Enter，强烈推荐使用 `Ctrl+Q`。*
  - **取消并丢弃修改**：按 `Esc`。
- **剪贴板与编辑**：
  - `Ctrl+C`：当存在非空选区时，将选中内容复制到系统剪贴板；
  - `Ctrl+V` 或直接粘贴：经过滤与控制字符清洗后插入当前光标处或替换选区；
  - `Ctrl+A`：全选整篇文档；
  - `Ctrl+Z` / `Ctrl+Y`：浮层内撤销 / 重做（500ms 内连续输入合并为单个撤销步）；
  - 方向键、Shift+方向键扩选、Ctrl/Alt+左右键按词跳转、Home/End 行首行尾。
- **附件芯片保护**：
  - 草稿中的 `[Image #1]`、`[Paste #2]` 等附件芯片被视作不可分割的原子整体，选区跨越时自动包含完整芯片，写回主输入框后仍可正常展开。
- **后台冲突检测**：
  - 保存时若检测到主草稿在后台已被修改，浮层会阻止覆盖并提示错误信息，按 `Esc` 退出。

## 限制与注意事项

1. **撤销历史重置**：主编辑器公开接口 `setEditorText` 在写入新文本时会清空主编辑器的内置 undo 栈（但保留原子芯片），因此保存返回后，主编辑器无法直接 undo 回进入浮层前的旧状态。
2. **光标位置**：退出浮层写回主输入框后，主输入框光标统一停在草稿末尾。
3. **终端 SGR 鼠标支持**：浮层依赖终端模拟器报告 SGR 鼠标事件（如 Windows Terminal、iTerm2、Kitty、Alacritty 等）。若在不支持 SGR 报告的终端中使用，底部会显示相关提示，但仍可完全通过键盘快捷键进行全键盘编辑。

## 开发与测试

- 类型检查：`bun run typecheck`
- 自动化测试：`bun test`
