# LabAgents Data Model

本文按当前 `core-ideas.md` 的主线定义数据模型：

```text
用户提出实验目标
-> agent 生成声明式实验方案
-> kernel 将方案展开并执行
-> 运行状态与产物回流
```

当前阶段不追求先定义完整实验系统对象体系，而是先把这条主链路的数据分层讲清楚。

与本文配套的实现分工文档：

- `kernel-execution-model.md`
  - 说明 `ProcedureSpec -> ExecutionUnit[] -> RunState` 的执行模型
- `raman-hardware-adapter-contract.md`
  - 说明以 Raman 为样板的资源、driver、runtime action 和 tool 接入方式

## Core Objects

### 1. `ExperimentIntent`

`ExperimentIntent` 回答的是：

**用户想做什么实验？**

它属于研究意图层，表达实验目标、假设、约束和这一轮实验想解决的问题。它可以被 agent 消费和整理，但不直接进入 kernel 执行。

**生产者**

- 用户
- planner / analyst
- replan / lineage

**消费者**

- planner
- agent memory / lineage
- `ProcedureSpec` builder

**应包含**

- `intentId`
- `experimentId`
- `objective`
- `hypothesis?`
- `question?`
- `constraints?`
- `successCriteria?`
- `evidenceRefs?`
- `notes?`

**不应包含**

- 具体实验步骤列表
- 仪器驱动参数
- 运行时状态
- artifacts 结果

### 2. `ProcedureSpec`

`ProcedureSpec` 回答的是：

**agent 准备怎么做这个实验？**

它是 agent 产出的**声明式实验方案**，由受控的实验语义结构组成。它不是脚本，不是通用控制流语言，也不是底层驱动命令集合。

当前阶段建议：

- `ProcedureSpec` 承载实验方案和具体步骤组织
- 步骤类型必须来自受控的 `procedure/step` 库
- 可以有受控的重复结构，例如 `grid_scan`、`point_list`、`repeat_n`
- Raman 单点当前位置采集使用显式 `current_position` plan，不用 `{xUm: 0, yUm: 0, zUm: 200}` 这类占位绝对坐标表达当前位置
- Raman 变温采集使用显式 `temperature_series` plan；目标温度属于 plan，稳定、dwell 与漂移重采规则属于 typed `domain.temperature`
- 不允许任意 `for / while / if` 之类通用脚本控制流
- 用户确认整次 bounded run 后，`ProcedureSpec` 会被冻结为本次 run 的唯一执行输入

**生产者**

- agent
- 受限的 spec builder / compiler

**消费者**

- kernel
- preflight / validation
- UI preview / review
- operator approval UI

**应包含**

- `procedureSpecId`
- `experimentId`
- `intentId`
- `procedureId`
- `procedureVersion`
- `resources`
- `limits`
- `plan`
- `stoppingRules`
- `retryPolicy?`
- `outputPlan?`

**不应包含**

- 用户自由文本推理过程
- 运行中的 progress / heartbeat
- 实际执行产物
- 底层 driver 命令

### 3. `RunState`

`RunState` 回答的是：

**kernel 现在把实验执行到哪里了？**

它属于运行时真相，表达当前 run 的状态、进度、异常、中断和产物索引。它由 kernel / runtime 产生，不由 planner 预写。

**生产者**

- kernel
- runtime
- watcher / resume logic

**消费者**

- operator UI
- analyst
- resume / recovery
- audit / replay

**应包含**

- `runId`
- `experimentId`
- `procedureSpecId`
- `status`
- `progress`
- `currentUnit?`
- `heartbeatAt?`
- `pauseReason?`
- `abortReason?`
- `errorState?`
- `pointAttempts?`
- `artifactRefs`
- `startedAt`
- `updatedAt`
- `endedAt?`

**不应包含**

- 用户意图本体
- 未归档的 LLM 推理
- 新的实验规划建议

## Planner-Side Parameter Templates

`ExperimentProcedureTemplate` 是 planner 侧的参数先验，不属于 kernel 的核心执行输入，也不属于运行时真相。它回答的是：

**对某类样品、某类实验和某个 procedure，agent 起草 `ProcedureSpec` 时可以参考哪些默认参数？**

当前 MVP 只为 Raman 规划使用该对象，但命名不绑定 Raman。模板来自 workspace-local 配置：

```text
lab-config/templates/*.json
```

匹配优先级固定为：

1. `sampleId` 精确匹配
2. `sampleClass` 匹配
3. intent keyword / tag 匹配
4. `procedureId` 默认模板

模板只保存可继承参数，例如：

- `resources`
- `limits`
- `planPerPoint`
- `stoppingRules`
- `retryPolicy`
- `domain`

模板不保存、也不应复制：

- `procedureSpecId`
- `experimentId`
- `intentId`
- 历史实验的具体点位坐标
- 审批状态、冻结状态或运行状态

模板默认值是建议，不是强约束。planner 可以按用户要求覆盖模板参数，但 proposal preview/details 必须说明：

- 使用的 `templateId`
- 使用的 `templateVersion`
- 继承了哪些字段
- 覆盖了哪些字段

如果没有模板匹配，planner 回到自主规划，并在提出 run 前向用户确认关键假设。`ProcedureSpec` schema 不因为模板而增加 provenance 字段；模板应用信息只出现在 planner / proposal details 中，避免污染 kernel 执行输入。

## Derived Runtime Object

### Compiled Units

当前阶段不必把 `ExecutionPlan` 抬成重对象。更合适的理解是：kernel 从 `ProcedureSpec` 编译出一组内部执行单元（compiled units / `ExecutionUnit[]`）。

它回答的是：

**这份声明式实验方案，展开后具体要按什么执行单元运行？**

建议职责：

- 将声明式 `ProcedureSpec` 展开成有限、明确、可恢复的执行单元
- 给每个执行单元分配稳定的 `unitId / index`
- 为 pause / resume / progress / artifact naming 提供稳定锚点

建议边界：

- compiled units 可以展开到语义 action
- 不应直接展开成底层 driver 命令流

例如：

- 允许：`move_to_point`、`autofocus`、`acquire_spectrum`
- 不允许：`serial_write`、`set_register`、`write_request_file`

建议编译链路：

```text
ExperimentIntent
-> ProcedureSpec
-> preflight / admission
-> user approves bounded run
-> compileUnits()
-> ExecutionUnit[]
-> kernel execute
-> RunState
```

关于这些 compiled units 如何被 kernel 托管执行，见 `kernel-execution-model.md`。

## Boundary Rules

当前建议保持以下边界习惯：

1. `ExperimentIntent` 可以影响 `ProcedureSpec`，但不能直接执行。
2. `ProcedureSpec` 是 agent 交给 kernel 的声明式实验方案，而不是运行中的状态记录。
3. 用户确认 run 后，kernel 只能执行该冻结 `ProcedureSpec` 编译出的 units；运行中不热改 spec。
4. compiled units 只能由 kernel 从 `ProcedureSpec` 派生，不由用户或 planner 直接编写。
5. `RunState` 只能由 runtime 产生，不能由 planner 预写。
6. kernel 直接消费 `ProcedureSpec` 以及内部编译结果，不直接消费 `ExperimentIntent`。

## Non-Core Context

以下信息会影响规划和执行，但当前不作为这条主链路里的核心交互对象：

- 硬件能力信息
- 当前实验环境状态
- 运行准入 / bounded-run approval / lease 契约（例如 `RunPolicy`）

它们更适合作为：

- runtime 提供的上下文输入
- preflight / validation 的检查输入
- Safety 目标态中的辅助约束对象

而不是当前这版最核心的数据分层。

其中，具体某一类真实硬件如何把这些上下文落到资源注册、driver 和 runtime action，可参考 `raman-hardware-adapter-contract.md`。

## Interaction Flow

```text
User
  -> ExperimentIntent
  -> agent refine / organize
  -> ProcedureSpec
  -> preflight / admission
  -> user approves bounded run
  -> kernel compileUnits
  -> ExecutionUnit[]
  -> kernel execute in background
  -> RunState
  -> summary / artifacts
  -> agent analyze / replan
```

## Persistence Guidance

当前阶段建议按职责持久化，而不是追求一次性设计完整记录体系。

- `ExperimentIntent`
  - 用于实验目标、lineage、replan 记录
- `ProcedureSpec`
  - 作为 run 的输入快照持久化
  - 用户批准后，该快照在本次 run 内保持冻结
- compiled units / `ExecutionUnit[]`
  - 当前先作为 kernel 内部编译结果
  - 只有在 debug / audit / resume 明确需要时，再考虑持久化
- `RunPolicy`
  - 当前作为辅助运行契约持久化最小摘要，例如 admission 结果、bounded-run approval、lease 信息
- `RunState`
  - 持久化当前状态和 append-only 事件历史

最小原则：

- 用户目标、agent 方案、kernel 状态三类事实不要混写
- append-only 的历史与当前快照分开
- artifacts 只保存真实实验产物，不代替 records

## Minimal Type Skeleton

```ts
type ExperimentIntent = {
  intentId: string
  experimentId: string
  objective: string
  hypothesis?: string
  question?: string
  constraints?: Record<string, unknown>
  successCriteria?: string[]
  evidenceRefs?: string[]
  notes?: string
}

type ProcedureSpec = {
  procedureSpecId: string
  experimentId: string
  intentId: string
  procedureId: string
  procedureVersion: string
  resources: Array<{ resourceId: string; role: string }>
  limits: Record<string, unknown>
  plan:
    | {
        kind: "grid_scan"
        grid: {
          origin: { xUm: number; yUm: number }
          rows: number
          cols: number
          pitchXUm: number
          pitchYUm: number
          order?: "row_major" | "snake"
        }
        perPoint: SemanticStep[]
      }
    | {
        kind: "point_list"
        points: Array<{ xUm: number; yUm: number; zUm?: number }>
        perPoint: SemanticStep[]
      }
    | {
        kind: "step_sequence"
        steps: SemanticStep[]
      }
    | {
        kind: "temperature_series"
        targetsK: number[]
      }
  stoppingRules?: {
    maxRuntimeMinutes?: number
    maxUnits?: number
    stopOnError?: boolean
  }
  retryPolicy?: {
    mode: "immediate_then_final"
    maxImmediateRetriesPerPoint: number
    maxFinalRetriesPerPoint: number
    finalRetryOrder: "failure_order"
    retryableFailureReasons: {
      execution: ["timeout"]
      quality: ["low_focus_confidence"]
    }
  }
}

type SemanticStep =
  | { kind: "move_to_point" }
  | { kind: "autofocus"; strategy?: string }
  | { kind: "set_temperature" }
  | { kind: "wait_for_temperature" }
  | {
      kind: "acquire_spectrum"
      laserPowerPercent: number
      integrationTimeMs: number
    }
  | { kind: "capture_frame" }

type ExecutionUnit = {
  unitId: string
  index: number
  unitKind: "point" | "step" | "batch"
  point?: { row?: number; col?: number; xUm: number; yUm: number; zUm?: number }
  temperatureTargetK?: number
  actions: SemanticStep[]
}

type RunPolicy = {
  executionMode: "live-supervised"
  requiresSupervisorPresence: true
  preflightReady: boolean
  controlAvailable: boolean
  approvalScope: "bounded_run"
  approvedProcedureSpecId?: string
  procedureSpecFrozen: boolean
  resourceLeaseRequirements?: Array<{ resourceId: string; mode: "exclusive-control" }>
}

type RunState = {
  runId: string
  experimentId: string
  procedureSpecId: string
  status: "queued" | "running" | "paused" | "aborted" | "failed" | "completed"
  progress?: { completedUnits: number; totalUnits?: number; unitKind?: string }
  currentUnit?: { unitId: string; index: number }
  pointAttempts?: Array<{
    pointUnitId: string
    attemptId: string
    attemptIndex: number
    phase: "initial" | "immediate_retry" | "final_retry"
    status: "succeeded" | "failed"
    failureType?: "execution" | "quality"
    failureReason?: "timeout" | "low_focus_confidence"
    finalForPoint?: boolean
    artifactIds?: string[]
    timestamp: string
  }>
  heartbeatAt?: string
  artifactRefs: string[]
}
```
