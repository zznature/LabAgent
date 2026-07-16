# Kernel 与仪器运行时集成设计

本文只回答一个问题：

> 当 Agent 已经产出 `ProcedureSpec` 之后，kernel 应该如何把它稳定执行成真实实验运行？

它强调的是 **kernel 设计**，不是某一类具体硬件如何接线、如何写 driver、如何暴露 tool。

文档分工如下：

- `kernel-execution-model.md`
  - 重点：kernel、`ExecutionUnit`、run lifecycle、runtime contract
- `raman-hardware-adapter-contract.md`
  - 重点：Raman 这类真实硬件怎样注册、封装、映射为 runtime action / tool
- `run-observation-artifact-contract.md`
  - 重点：kernel/runtime 如何通过 Run Records Module 固定 progress、attempt、events 与 artifacts，并向后端提供读取 interface

## 1. 第一性原理

先把整个链路拆开：

- User 负责表达研究目标
- Agent 负责把目标收敛为 `ProcedureSpec`
- Kernel 负责把 `ProcedureSpec` 托管执行
- Runtime / Driver 负责控制真实硬件

如果 kernel 不明确拥有执行边界，系统会退化成两种坏形态之一：

1. Agent 直接调硬件脚本
2. Python 硬件脚本偷偷持有整个实验 workflow state

这两种都不符合当前设计目标。

因此 kernel 必须坚持四个原则：

1. **`ProcedureSpec` 是唯一执行输入**
2. **kernel 拥有实验级 workflow state**
3. **runtime 只负责设备级动作，不负责实验级编排**
4. **pause / abort / resume 必须围绕 kernel 的执行边界定义**

## 2. Kernel 真正负责什么

kernel 更像实验执行器，而不是研究规划器。

它负责：

- 接收 `ProcedureSpec`
- 验证其可编译性和执行边界
- 将 plan 编译成 `ExecutionUnit[]`
- 在 unit 边界推进执行
- 持久化 `RunState`、events、artifacts
- 响应 pause / abort / resume
- 将 runtime 的设备结果折叠回实验级状态

它不负责：

- 理解研究假设
- 生成实验方案
- 持有底层设备连接
- 直接暴露底层 driver 命令给 Agent

一句话说，kernel 回答的是：

> 这份实验方案应该按什么顺序、以什么恢复边界、通过什么状态机被执行？

## 3. 对象流

推荐把主链路收紧成下面这条：

```text
ExperimentIntent
  -> ProcedureSpec
  -> compileUnits()
  -> ExecutionUnit[]
  -> execute units via runtime
  -> RunState / events / artifacts
```

边界要非常明确：

- `ExperimentIntent` 不进入 runtime
- `ProcedureSpec` 不包含运行中状态
- `ExecutionUnit[]` 只能由 kernel 派生
- `RunState` 只能由 runtime + kernel 共同产生，不能由 planner 预写

## 4. `ProcedureSpec` 在 kernel 看来应该是什么

对 kernel 而言，`ProcedureSpec` 是一份**声明式实验方案**，不是脚本。

它应该表达：

- procedure 类型
- resources
- limits
- plan
- stopping rules
- retry policy
- typed domain params

它不应该表达：

- Python method name
- 串口命令
- driver 命令序列
- 任意 `for / while / if`

kernel 关心的不是 `ProcedureSpec` 的文案，而是它能否被稳定展开成有限、明确的执行单元。

### 4.1 实验失败重试策略

实验失败重试属于 `ProcedureSpec` 的协议语义，由 kernel / execution scheduler 确定性执行。它不属于 agent 运行时推理，也不属于 runtime / driver 的局部脚本状态。

MVP 仅支持 point-level Raman mapping 的失败重试，策略名固定为：

```ts
retryPolicy: {
  mode: "immediate_then_final"
  maxImmediateRetriesPerPoint: 1
  maxFinalRetriesPerPoint: 1
  finalRetryOrder: "failure_order"
  retryableFailureReasons: {
    execution: ["timeout"]
    quality: ["low_focus_confidence"]
  }
}
```

语义规则：

- `execution` failure 表示执行流程失败，例如采集超时。
- `quality` failure 表示动作完成但数据质量不达标，例如聚焦置信度低。
- scheduler 先执行主扫描；每个点遇到可重试失败时，最多立即重试 `maxImmediateRetriesPerPoint` 次。
- 只有已经用完 immediate retry 后仍失败、且最后一次失败仍属于策略表的点，才进入 final retry queue。
- final retry queue 在所有正常点位完成后按失败发生顺序执行，最多重试 `maxFinalRetriesPerPoint` 次。
- 每次 attempt 都必须进入 run history；成功 attempt 决定该点最终成功，失败 attempt 不被覆盖。

MVP 策略表只启用：

- `execution.timeout`
- `quality.low_focus_confidence`

后续可以扩展更多质量失败原因，例如 low signal-to-noise、saturation、missing peak 或 cosmic ray artifact，但不能把 retry 判断写成散落在 agent prompt 或 driver callback 里的临时逻辑。

## 5. `ExecutionUnit` 为什么是 kernel 核心对象

`ExecutionUnit` 是 kernel 的核心，不是附属实现细节。

原因很简单：

- 没有 unit，就没有稳定的 pause / resume 边界
- 没有 unit，就没有可靠的 progress
- 没有 unit，就没有明确的 artifact 命名锚点
- 没有 unit，运行状态会再次退化成“某个脚本跑到哪了”

建议 `ExecutionUnit` 回答的问题是：

> 当前这份实验方案，下一次最小可托管执行块是什么？

### 5.1 推荐字段

最小建议：

- `unitId`
- `index`
- `unitKind`
- `point?`
- `actions`
- `resumeKey`

`ExecutionUnit` 不再携带 `artifactPathPrefix` 或正式 artifact path。compiler 只产生 path-safe
`unitId`；kernel 为每次执行分配 `attemptId`，Run Records Module 再从 run/unit/attempt/action
identity 生成正式目录。

### 5.2 推荐粒度

MVP 阶段优先选择**point-level** 或 **step-sequence-level** unit。

例如 Raman mapping：

- 一整个 mapping 不是一个 unit
- 一个 point 是一个 unit
- 一个 point 内的多个设备动作由 kernel 顺序协调

不建议：

- 把整张扫描表交给 runtime 一次跑完
- 把每个硬件微步都提升成 kernel unit

前者恢复边界太粗，后者执行面会碎到难以维护。

## 6. kernel 编译阶段应做什么

`compileUnits()` 至少要做六件事：

1. **规范化 plan**
   - 统一 `grid_scan`、`point_list`、`step_sequence`

2. **展开声明式结构**
   - `grid_scan -> point units`
   - `step_sequence -> step units`

3. **绑定语义动作模板**
   - 为每个 unit 生成固定 action 列表

4. **注入执行元数据**
   - `unitId`
   - `index`
   - coordinates
   - run/unit/attempt/action identity（正式路径由 Run Records Module 生成）
   - resume cursor

5. **落地限制约束**
   - 激光上限
   - 运动边界
   - 域内 guard

6. **形成恢复边界**
   - 明确哪些边界可以自动 resume
   - 哪些边界只能 pause 后等待人工处理

Raman live `grid_scan` 的 origin 必须同时携带 `xUm / yUm / zUm`；compiler
把固定 Z 复制到每个 point unit。preflight 必须在审批前对编译后的所有 unit
执行 runtime contract validation，不能让 schema 合法但缺少 live runtime 必需字段的
unit 进入启动阶段。

编译结果允许停留在**语义 action 层**，不应直接变成 driver 命令流。

允许：

- `move_to_point`
- `autofocus`
- `acquire_spectrum`

不允许：

- `serial_write`
- `set_register`
- `write_request_file`

## 7. kernel 与 runtime 的正式契约

kernel 和具体硬件之间必须隔着 runtime contract。

kernel 不应该直接 import 某个具体 driver，也不应该知道某个设备是用 SDK、文件桥还是 VISA。

### 7.1 kernel 向 runtime 提交什么

建议 kernel 只提交：

- `ExecutionUnit`
- 当前 `RunContext`
- unit 内要执行的语义 action
- timeout / cancel / checkpoint 约束

### 7.2 runtime 向 kernel 返回什么

至少要返回：

- `ok / failed / paused`
- action / unit 级 summary
- artifacts
- progress
- typed error code
- `retrySafe`
- `needsOperator`
- `safeToResume`

### 7.3 kernel 不应该看到什么

kernel 不应该看到：

- 具体 SDK object
- 文件桥目录轮询细节
- request filename
- channel number
- traceback 文本作为主要控制信号

kernel 看到的应该始终是**结构化执行结果**。

## 8. run lifecycle 必须由 kernel 拥有

只要运行生命周期不在 kernel 手里，所谓托管执行就是假的。

推荐收紧成下面这组状态：

- `queued`
- `running`
- `paused`
- `aborted`
- `failed`
- `completed`

以及下面这组关键操作：

- `start(runId, spec)`
- `pause(runId)`
- `abort(runId)`
- `resume(runId)`
- `poll(runId)` 或事件订阅

### 8.1 pause / abort 语义

pause / abort 必须在 kernel 认可的安全边界生效：

- unit 边界
- action checkpoint
- runtime 明确宣称可中断的动作点

runtime action 返回后也是强制 checkpoint：kernel 必须先重新检查 abort，再处理 pause / deadline，
最后才能接受 attempt 或完成 unit。这样即使 operator 在最后一个 unit 执行期间请求 abort，
该 unit 也不会被接受，run 不会错误进入 `completed`。

不能依赖“中断当前前台函数调用”来代替 run cancellation。

`stoppingRules.maxRuntimeMinutes` 同样是 kernel 硬约束。kernel 在 unit checkpoint
检查 deadline；超过批准时长后以 `run_deadline_exceeded` 结束，不继续启动新 unit。

### 8.2 resume 语义

resume 只能发生在显式受支持的边界：

- 上一个 completed unit 之后
- 某个 action 返回 `safeToResume = true` 的 checkpoint

否则就应该进入 `paused/recovering`，而不是假装可以无损继续。

MVP 的 `resume_run` 保留原 `runId`，跳过已经具有 `acceptedAttemptId` 的 unit，并为未完成
unit 分配新的 immutable attempt。旧 attempt 的 descriptor 与 representations 不覆盖；新结果只有在
kernel 写入新的 `acceptedAttemptId` 后才成为正式采用结果。

## 9. `RunState` 应该怎样由 kernel 维护

`RunState` 是 kernel 对运行真相的表达。

建议至少包括：

- `runId`
- `procedureSpecId`
- `status`
- `currentUnit`
- `completedUnits`
- `totalUnits?`
- `heartbeatAt`
- `pauseReason?`
- `abortReason?`
- `errorState?`
- `artifactRefs`

关键习惯：

- 当前快照和 append-only 事件分开
- artifact index 和运行状态分开
- `RunState` 只表达“现在如何”，不表达“接下来建议怎么做”
- logical point、attempt 与 artifact scope 分开：重试不会产生新的 logical point，
  kernel 生成的 artifact 保留在同一 point scope 下的独立 attempt 子目录；
  runtime 返回且源文件可访问的 artifact 会复制到该目录后再登记，无法访问的外部引用
  保留原 path 并标记 `externalOnly`
- summary 分别报告 failed attempts、retried points、recovered points 与 final failed points

## 10. 错误模型必须服务 kernel 决策

kernel 不需要最完整的异常学术分类，但必须能根据错误做运行级决策。

至少要能区分：

1. **可重试**
2. **需要人工介入**
3. **必须停止当前 run**
4. **允许安全 resume**

所以 runtime 回来的错误不应该只是字符串 message，而应该至少包含：

- `errorCode`
- `retrySafe`
- `needsOperator`
- `safeToResume`
- `scope`（action / unit / run）

这是 kernel 判断 pause / retry / abort 的基础。

run 因连续失败阈值结束时，顶层错误同时保留 terminal error 和
`payload.triggeringError`，避免聚合错误覆盖最初的设备或契约根因。

## 11. 观测、进度与 artifact 应该怎样进入 kernel

kernel 不只是“调一下 runtime 然后等结果”。

它必须能托管长动作，因此需要显式观测面：

- progress event
- heartbeat
- checkpoint
- artifact emission

推荐原则：

1. **progress 不等于日志**
   - 需要结构化字段，而不是 stdout 文本

2. **artifact 不等于 message**
   - 大文件只通过 artifact ref 回流

3. **heartbeat cadence 独立于动作时长**
   - 长积分、扫描、等待稳定都要有心跳

4. **kernel 消费摘要，不消费设备内部实现细节**

具体持久化与观察 interface 统一由 `run-observation-artifact-contract.md` 定义。kernel 负责
run/unit/attempt lifecycle 与 `acceptedAttemptId`；runtime 负责 canonical artifact 的科学语义；
正式路径、descriptor、checksum、index、sequence 和原子发布集中在 Run Records Module，
不再由 compiler、每个 runtime 或 Python daemon 分别拼接。

## 12. fake / mock 路径为什么属于 kernel 设计一部分

很多人把 fake 路径看成“驱动层附属物”，这是不对的。

对 kernel 来说，fake path 的价值是：

- 验证 `ProcedureSpec -> ExecutionUnit[]` 是否正确
- 验证 pause / abort / resume 状态机
- 验证 artifact / event / error contract
- 验证 runtime contract 是否足够稳定

因此 fake / mock 路径不是可有可无，它直接决定 kernel 是否可迭代。

## 13. 与 safety 的关系

本文不展开完整 safety 体系，但 kernel 必须至少承担两件事：

1. 将 `ProcedureSpec.limits` 带入执行边界
2. 不绕过 runtime / driver 的最终硬防线

live approval 不信任 Agent 传入的 readiness 布尔值。启动入口会针对 proposal 中
同一份 spec hash 重新执行 runtime preflight、compiled-unit contract validation、
forbidden risk 与 stage anchor 校验，然后才冻结并启动。

更复杂的：

- lease
- supervision
- approval lifecycle
- 风险分级

可以继续在更高层设计，但 kernel 至少不能破坏这些边界。

## 14. MVP 约束

为了避免把 kernel 设计成一个过早的平台框架，当前阶段建议坚持：

1. 不把 `ProcedureSpec` 设计成脚本语言
2. 不把 runtime 退化成“随便执行一段驱动调用”
3. 不把 unit 粒度做得过粗或过碎
4. 不让 Agent 直接进入 execution hot path
5. 所有抽象都直接服务于：
   `Intent -> ProcedureSpec -> ExecutionUnit[] -> RunState`

## 15. 当前结论

`kernel-execution-model.md` 的结论应收敛到下面这句话：

> kernel 的职责不是接设备，而是把 `ProcedureSpec` 编译为可恢复、可观测、可托管的 `ExecutionUnit[]`，再通过稳定的 runtime contract 推进执行，并把结果收敛成 `RunState`、events 和 artifacts。

具体某一类硬件怎么注册、如何封装 driver、如何暴露 tool，不在本文展开，交给 `raman-hardware-adapter-contract.md`。
