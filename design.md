## Design Doc: VS Code 轻量高精度代码跳转插件（单人开发版）

### 1. 背景与目标
cpptools 内存占用过高导致被禁用，需要自研 C/C++ 跳转插件。目标是在禁用 cpptools 的前提下，提供高精度跳转，并将总内存峰值控制在 <500MB。

### 2. 设计目标
1. 功能目标
- 支持 Go to Definition、Go to Declaration、Go to Implementation、Peek、Find References、跳转返回栈。
- 覆盖模板、宏、跨文件 include 场景。

2. 性能目标
- 常见跳转延迟中位数 <400ms。
- 总体峰值内存 <500MB（clangd + 扩展）。

3. 工程目标
- 单人 4 周交付可发布 v1。
- 架构预留多语言扩展。

### 3. 范围定义
1. In Scope（v1）
- C/C++ 跳转主能力。
- compile_commands 发现与解析。
- 模板/宏基础增强。
- 缓存、诊断、自动恢复。

2. Out of Scope（v1）
- 重构能力（rename/extract）。
- 深度补全增强。
- 调用图、继承图可视化。

### 4. 技术选型
1. 核心路线
- 内置 clangd，扩展作为 LSP 客户端与资源调度层。

2. 选型理由
- clangd 在 C++ 模板/宏语义上成熟，精度和稳定性高。
- 单人开发不适合自建语义分析器，维护成本太高。

### 5. 架构设计
1. 模块划分
- Extension Host：激活、命令注册、UI 反馈、配置管理。
- Clangd Manager：二进制定位、进程生命周期、健康检查、崩溃重启。
- LSP Bridge：definition/declaration/implementation/references 请求封装。
- Context Resolver：compile_commands 与 include path 管理。
- Cache Layer：L1 内存缓存 + L2 磁盘缓存。
- Metrics：耗时、命中率、失败原因、内存采样。

2. 运行时流程
- 用户触发跳转命令。
- LSP Bridge 发请求给 clangd。
- clangd 返回候选结果。
- 扩展执行去重与排序。
- 单结果直接跳转，多结果弹选择器。

### 6. 关键流程
1. 启动流程
- 扩展惰性激活。
- 检测并启动 clangd。
- 扫描 compile_commands（根目录、build、用户路径）。
- LSP ready 后开放跳转命令。

2. 跳转流程
- 输入：当前文档 URI + 光标位置。
- 调用：definition/declaration/implementation/references。
- 后处理：排序、去重、候选解释。
- 输出：编辑器跳转或候选面板。

3. 异常流程
- clangd 退出：自动重启并提示。
- compile_commands 缺失：提示手工配置。
- 请求超时：返回可诊断错误并记录日志。

### 7. 精度策略
1. 模板
- 同时保留模板定义与实例上下文候选。
- 排序优先：同文件作用域 > 同命名空间 > 其他。

2. 宏
- 优先定位宏定义。
- 宏链复杂时提供多候选并展示来源。

3. include
- 基于 compile_commands 解析 include 路径。
- 路径归一化，适配 Linux/Windows/macOS。

### 8. 性能与内存策略
1. 资源策略
- 限制 clangd 后台索引强度与缓存规模。
- 惰性激活与增量更新，避免无效全量重建。

2. 缓存策略
- L1：近期跳转热点与候选缓存。
- L2：磁盘索引元数据，带版本戳和失效策略。

3. 观测指标
- 跳转耗时 p50/p90。
- 命中率与失败率。
- 内存峰值与增长趋势。

### 9. 配置项
- openbmcJump.clangd.path：clangd 路径覆盖。
- openbmcJump.compileCommands.path：compile_commands 覆盖路径。
- openbmcJump.compileCommands.searchRoots：OpenBMC 等大型构建目录的递归搜索根。
- openbmcJump.compileCommands.maxSearchDepth：递归搜索深度上限。
- openbmcJump.requestTimeoutMs：跳转请求超时。

### 9.1 OpenBMC 适配约束
- OpenBMC 仓库常见问题不是 clangd 精度，而是 compile_commands.json 分散在 build/tmp/work 等深层目录。
- 自动发现策略需优先支持 build、tmp 等根目录下的递归搜索，但必须限制深度，避免大型构建树扫描成本失控。
- 在 OpenBMC 场景下，推荐优先允许用户直接配置 compile_commands 路径；自动发现作为兜底，而非唯一方案。

### 10. 目录结构建议
- src/extension.ts：入口与命令注册。
- src/clangd/manager.ts：clangd 进程管理。
- src/lsp/navigation.ts：LSP 导航请求。
- src/context/compileDb.ts：编译数据库解析。
- src/ui/resultPicker.ts：多候选选择。
- test/accuracy：精度用例。
- test/perf：性能压测。

### 11. 验收标准
1. 功能
- 各跳转命令可用，多候选可解释可回退。

2. 精度
- 模板/宏/重载/跨文件样例总体准确率 >85%。

3. 性能
- 峰值内存 <500MB。
- 常见跳转延迟中位数 <400ms。

4. 稳定性
- clangd 异常可自动恢复。
- 1 小时持续操作无明显内存持续攀升。

### 12. 单人开发机制
- 每天只追 1-2 个可闭环目标。
- 每日节奏：实现 -> 回归 -> 记录。
- 每周复盘：失败样例 Top10、下周调整项。
- 发布前 48 小时冻结新功能。
