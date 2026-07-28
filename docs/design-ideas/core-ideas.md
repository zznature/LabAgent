# LabAgents MVP 核心设计

本文只冻结 LabAgents MVP 的产品方向和架构边界。具体 schema、Raman 参数、运行算法与实施状态由专题文档定义，不在总纲中重复；文档索引与职责见 `README.md`。

## 1. 产品命题

LabAgents 要把自然语言研究目标变成可审查、可执行、可恢复的实验运行：

```text
用户表达研究目标
-> agent 收敛声明式实验方案
-> 用户批准一次有界运行
-> 确定性 kernel 托管执行
-> 状态、错误与产物回流
-> agent 协助分析和规划下一步
```

当前 MVP 以 Raman 为第一条真实纵向切片，已经覆盖 simulation 与 `live-supervised` 下的单点采集、有界参数搜索、焦平面校准和 mapping。Raman 用来验证通用边界，不是最终架构本身。

产品目标不是让 LLM 自主控制实验室，而是让 agent 的实验规划真正落到硬件，同时把执行状态、安全边界和恢复责任留在确定性系统中。

## 2. 六条核心原则

1. **从研究意图开始，而不是从脚本开始。**
   用户描述目标、假设、约束和成功条件；系统不要求用户先写执行步骤或驱动命令。

2. **agent 负责规划，kernel 负责执行。**
   agent 补全参数并提出实验方案；kernel 将批准后的方案编译成有限执行单元，管理状态机并调用 runtime。LLM 不进入执行热路径。

3. **对上暴露实验语义，对下隔离设备细节。**
   agent 面向采谱、对焦、移动和 mapping 等语义能力；串口、SDK、文件桥和 driver session 留在 runtime / driver 层。

4. **一次 bounded run 是执行与批准的基本单位。**
   每次真实实验都有明确范围、资源、限制、停止条件和预计产物。新 run 需要新批准；已批准 run 内不热改方案，也不无界扩大搜索。

5. **运行事实必须结构化、持久化并可恢复。**
   进度、错误、attempt、heartbeat 和 artifact 不能只存在于对话或设备进程内存中。长时运行由 kernel 托管，支持观察、暂停、中止和受控恢复。

6. **人提供实验判断，不充当协议搬运工。**
   人负责补充实验信息、审查方案、批准危险动作和处理真实异常。系统已经持有的 spec、hash、run state 和诊断信息不得要求人或 agent 重复提供；终态和可行动错误应主动回流。减少这类往返不等于放宽批准或硬限制。

## 3. 核心数据边界

主链路只有三个核心交互对象；`ExecutionUnit[]` 是 kernel 的派生运行时对象，不是第四个用户或 planner 对象。

| 对象 | 回答的问题 | 边界 |
| --- | --- | --- |
| `ExperimentIntent` | 用户想解决什么研究问题？ | 表达目标、假设、约束和成功条件；影响规划，但不进入 kernel 执行 |
| `ProcedureSpec` | agent 准备怎样做这次实验？ | 声明 procedure、资源引用、计划、领域参数、limits、停止与重试规则；是 kernel 的唯一方案输入 |
| `ExecutionUnit[]` | kernel 下一步执行哪些有限单元？ | 只能由 kernel 从 `ProcedureSpec` 编译，用于进度、artifact 命名和 pause / resume 边界 |
| `RunState` | 这次运行实际进行到哪里？ | 由 kernel / runtime 产生，记录状态、进度、错误、attempt 和 artifact refs；planner 不得预写 |

必须保持以下不变量：

- 用户批准后，kernel 只执行被冻结 `ProcedureSpec` 编译出的 units。
- `ExecutionUnit[]` 不由用户或 planner 直接编写，也不展开为底层设备协议。
- kernel 不直接消费 `ExperimentIntent`；agent 通过 `ProcedureSpec` 把意图转成执行输入。
- 用户目标、agent 方案与 kernel 运行事实不得混写。

`ExperimentProcedureTemplate` 是 planner 侧参数先验；硬件配置是 runtime 上下文；proposal、approval 和 artifact records 是辅助契约。它们都不应被提升为新的核心对象，也不应污染 `ProcedureSpec`。

artifact 是 runtime 产生的实验事实。大文件通过结构化 `ArtifactRef` 回流；跨 run 引用必须显式绑定 identity 和完整性信息，不能靠目录扫描、文件名猜测或聊天记忆选择“最近结果”。

## 4. 端到端运行契约

当前 MVP 的正式路径是：

```text
ExperimentIntent
-> draft ProcedureSpec
-> validate + preflight
-> proposal { proposalId, specHash }
-> operator approves the exact proposal
-> freeze ProcedureSpec
-> compile ExecutionUnit[]
-> execute through runtime
-> RunState + events + artifacts
-> terminal summary
```

这条路径有四个关键约束：

1. **修改就是新提案。**
   pending proposal 的参数修改产生新的 `proposalId + specHash`，旧批准不继承。

2. **恢复不等于重启。**
   paused run 从持久化的当前 unit 继续，重新读取冻结 spec 并校验 unit identity；调用方不能借 resume 重传 spec 或任意跳点。

3. **错误必须可行动。**
   agent 可见摘要直接包含 error code、可理解 message 和关键数值。结构化诊断不能只藏在内部 details 或 event log。

4. **终态主动回流。**
   paused、failed、completed 和 aborted 主动通知会话；`poll` 仍可用于查询，但人不应靠反复轮询推动协议。

## 5. 上下文与仪器接入

实验 agent 不能只依赖对话记忆。当前至少保留四类结构化上下文：

- **实验室能力与稳定配置**：有哪些资源、语义动作和硬边界。
- **当前环境状态**：设备是否 ready、当前位置和控制权是否可用，由 runtime 读取。
- **规划先验**：workspace-local 实验模板提供可覆盖的默认参数，不进入可执行 spec。
- **运行与结果**：冻结 spec、`RunState`、append-only events 和 artifacts 分开持久化。

真实仪器按下面的单向依赖接入：

```text
resource config
-> device driver
-> bounded runtime action
-> planner / operator tool surface
```

- planner-facing surface 用于形成、验证和发起实验方案，不暴露驱动原语。
- operator-facing surface 用于状态读取、维护和诊断；有副作用的维护动作仍需确认并受 runtime hard limits 约束，但不必伪装成完整实验 run。
- 长周期、多点 workflow 属于 kernel，不能藏在 Python loop、tool callback 或 daemon 内。
- simulation / fake runtime 必须遵守同一 schema、状态机和错误契约，使无硬件开发能验证真实执行边界。

## 6. 当前安全边界

`live-supervised` 表示真实硬件运行必须经过人工审查与批准；它目前不证明监督者物理在场，也不是完整 safety system。

MVP 已冻结的最小边界是：

1. 启动前要求 preflight ready 且设备控制可用。
2. operator 审查精确 proposal，并确认对应 `proposalId + specHash`。
3. 启动后冻结 `ProcedureSpec`，run 内不热改、不自动扩大范围。
4. 运动范围 / 物镜净空与激光功率由 runtime / driver 执行硬限制，批准不能绕过。
5. 风险使用 `notice / confirm_required / forbidden` 三档参与准入判断。
6. operator 可以在安全边界 pause / abort；live resume 仍需明确确认。
7. 独立的 effectful maintenance action 逐次确认，并继续受相同硬件边界约束。

当前明确不声称已经具备：

- 监督者物理在场校验
- 通用规则 watchdog
- 多 agent 设备 lease 仲裁
- 多角色审批
- 自主连续发起多个真实 run
- 完整的审计与 canonical artifact lifecycle

这些能力只有在真实需求出现并冻结新契约后才进入设计；不提前引入通用 policy engine 或新的核心对象。
