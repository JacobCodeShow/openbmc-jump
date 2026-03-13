## Plan: 轻量高精度代码跳转插件

面向 C/C++ 的 VS Code 跳转插件，采用“内置 clangd + 精细化资源控制”的方案，在禁用 cpptools 前提下实现高精度定义/声明/实现跳转。首版目标 4 周交付较完整 v1，内存峰值控制在 <500MB，优先保障模板与宏相关场景的跳转准确率。

## Steps
1. 需求冻结与验收口径定义（第 1-2 天）
- 明确 v1 必做能力：Go to Definition、Go to Declaration、Go to Implementation、Peek、Find References、返回跳转栈。
- 明确性能与质量门槛：总内存峰值 <500MB，常见跳转延迟 <400ms，复杂模板/宏场景准确率目标 >85%。
- 定义不做范围：重构与补全增强不纳入 v1。

2. 技术基座搭建（第 3-6 天）
- 初始化插件骨架（TypeScript + VS Code Extension API）。
- 集成 clangd 生命周期管理：启动、心跳、异常重启、版本自检。
- 建立 LSP 桥接层，封装 definition/declaration/implementation/references。

3. 编译上下文与路径解析（第 2 周）
- compile_commands.json 自动发现（根目录、build、可配置路径）。
- 解析编译参数与 include path，跨平台路径归一化。
- 数据库有效性检查与降级策略。

4. 精准跳转增强（第 3 周）
- 模板场景：definition/implementation 多候选可解释选择。
- 宏场景：优先跳转宏定义，复杂链路多候选回退。
- include 相关跳转：头文件定位与声明/实现跨文件联动。

5. 内存与性能控制（第 3-4 周）
- 进程级参数调优：后台索引强度、AST 缓存规模、内存上限。
- 缓存设计：L1 内存缓存 + L2 磁盘缓存，文件变更增量失效。
- 监控采样：启动耗时、跳转耗时、内存峰值。

6. 测试与验收（第 4 周）
- 分层用例：简单函数、类层次、模板、宏、复杂 include 图。
- 自动化回归：固定跳转点和期望目标，输出准确率报表。
- 压测与稳定性：长时间跳转、频繁切换、clangd 异常恢复。

7. 发布准备与后续路线（第 4 周末）
- 打包发布（内置 clangd 分平台产物）、安装体积评估、更新通道。
- 文档：项目接入、compile_commands 生成、问题排查。
- 规划 v2：多语言抽象、索引增强、调用图/继承图。

## Daily Checklist（4周）
### 第1周（基础框架）
- Day 1：创建骨架，配置激活事件、命令、日志通道。
- Day 2：接入 clangd 管理（启动/停止/重启），版本检测。
- Day 3：完成 LSP 通信封装，跑通 definition。
- Day 4：接入 declaration/implementation/references，统一错误处理。
- Day 5：完成 compile_commands 自动发现与读取。
- Day 6：补齐 include path 解析与路径归一化。
- Day 7：周回归（冒烟 + 首次内存采样）。

### 第2周（精度提升）
- Day 8：实现多候选跳转选择器。
- Day 9：模板专项处理（定义/特化/实例上下文）。
- Day 10：宏专项处理（定义定位/链路回退）。
- Day 11：声明/实现互跳增强（.h/.cpp）。
- Day 12：include 异常场景补强。
- Day 13：建立精度基线数据集。
- Day 14：周回归（精度报告 + Top10 失败样例）。

### 第3周（性能稳定）
- Day 15：L1 缓存与命中统计。
- Day 16：L2 磁盘缓存与失效机制。
- Day 17：文件变更增量更新链路。
- Day 18：clangd 参数调优。
- Day 19：诊断面板（耗时/失败/内存）。
- Day 20：高频压测。
- Day 21：周回归（性能报告）。

### 第4周（验收发布）
- Day 22：修复高优先级缺陷。
- Day 23：稳定性专项（崩溃恢复、异常路径、损坏配置）。
- Day 24：跨平台验证（Linux/Windows/macOS）。
- Day 25：端到端回归 + 发布候选构建。
- Day 26：文档完善。
- Day 27：灰度发布与反馈。
- Day 28：正式发布与 v2 需求池整理。

## Weekly Milestones（Go/No-Go）
1. Week 1：基础能力可用
- Go：definition/declaration/implementation/references 主链路可用；compile_commands 自动发现成功率 >90%。

2. Week 2：精度初达标
- Go：模板/宏样例总体准确率 >80%；多候选 UI 可解释可回退。

3. Week 3：性能达标
- Go：峰值内存 <500MB；常见跳转延迟中位数 <400ms；长压测无持续攀升。

4. Week 4：发布就绪
- Go：P0/P1 缺陷清零；跨平台通过；发布与回滚流程可执行。

## Solo Mode Adjustments
- 你同时承担架构、开发、测试、发布角色。
- 时间分配建议 6:3:1（实现:测试调优:文档发布）。
- 任何新功能超过 1 天未闭环，立即拆分降级。
- 发布前必须满足三门禁：功能通过、内存达标、回滚可用。
- 每天最后 30 分钟固定回归与日志整理。
