# Run Observation 与 Artifact Contract（status: implemented MVP）

本文回答一个问题：

> LabAgents 如何以固定位置、固定格式保存实验产物，并通过稳定的后端 interface 让前端观察 run 进展与结果？

本文整合 `docs/adr/0001` 至 `0026` 已确认的决策。ADR 保留决策历史，本文是实现时优先阅读的综合技术方案。

本文不改变 `core-ideas.md` 的三个核心对象。`Run Observation Snapshot`、`Run Observation Event`、`Execution Attempt` 和 `Artifact Descriptor` 都是 `RunState` 周围的运行记录与观察模型，不是新的 planner/kernel 核心输入。

## 1. MVP 目标与非目标

### 1.1 目标

MVP 只解决四件事：

1. 同一 bounded run 的进展和结果始终归属同一个 `runId`。
2. retry / resume 不覆盖旧 attempt，kernel 显式选择正式采用的 attempt。
3. Source 与 Canonical Artifacts 使用固定目录、固定 descriptor 和固定 Raman profile。
4. 前端通过后端读取 snapshot、ordered events 和 artifact representations，不扫描文件系统。

### 1.2 非目标

MVP 不实现：

- 完整 event sourcing 或通用审计平台
- schema 升级兼容、历史 migration 或旧版本 reader
- 自动删除正式 artifacts 的 retention policy
- remote object storage、数据库或分布式事务
- 任意仪器的通用 artifact profile marketplace
- 前端框架、具体页面或 SSE / WebSocket 选型
- 从 artifact/file count 推断 run progress

## 2. 不变量

### 2.1 Run 与 attempt

- 一次 bounded run 只有一个 `runId`。
- pause / resume / retry 保留原 `runId`。
- 一个 `ExecutionUnit` 的每次执行都有独立、不可变、path-safe 的 `attemptId`。
- 新 attempt 不覆盖旧 attempt 的文件、descriptor 或失败证据。
- unit 成功时，kernel 必须显式写入 `acceptedAttemptId`。
- 前端禁止根据 attempt 编号、时间戳或文件修改时间推断正式结果。

### 2.2 Progress 与 artifacts

- `RunState` 仍是当前运行事实。
- progress 来自 Run Observation Snapshot / Events，不来自文件数量。
- artifacts 是实验产物，不是 progress 计数器。
- 只有 lifecycle 为 `complete` 的 artifact representation 可以读取或渲染。

### 2.3 Source 与 Canonical

- Driver / Python worker 产生 Source Artifact 或 source path。
- bridge / daemon 路径只是 staging，不是正式实验记录位置。
- Runtime 对 Canonical Artifact 的科学语义、schema 校验和接受负责。
- Source Artifact 保留设备原始证据；Canonical Artifact 提供前端稳定格式。
- Canonical Artifact 必须记录其 Source Artifact provenance。
- 正式 representations 全部记录 byte size 与 SHA-256。

### 2.4 Operator operation

- 不属于 bounded run 的 operator frame/autofocus/smoke spectrum 使用独立 `operationId`。
- operator operation 可记录 `relatedRunId`，但不能写入该 run 的正式 artifact scope。
- 只有 kernel-owned Execution Attempt 能产生 bounded run 的 accepted result。

## 3. Deep Module 设计

### 3.1 Module 与 seam

新增一个 `Run Records Module`。它的 seam 位于：

```text
kernel/runtime write side
        -> Run Records Interface
backend read adapter
        -> Run Records Interface
```

该 Module 负责把以下复杂性藏在一个小 interface 后面：

- run observation snapshot 与 ordered event sequence
- unit / attempt 状态和 accepted attempt
- artifact staging、normalization、schema validation、checksum 与原子发布
- artifact descriptor、index 与固定目录布局
- interrupted publication recovery
- operator operation artifact scope

删除这个 Module 后，上述复杂性会重新散落到 kernel、每个 runtime、每个 tool 和后端调用者中；因此它具有足够 Depth，而不是一个 pass-through wrapper。

### 3.2 最小 Interface

以下是方向性 TypeScript interface；字段以实现阶段的 TypeBox schema 为准：

```ts
interface RunRecords {
  initializeRun(input: InitializeRunInput): RunObservationSnapshot
  applyRunChange(runId: string, change: RunObservationChange): RunObservationSnapshot
  publishArtifact(input: PublishArtifactInput): ArtifactDescriptor
  readRun(runId: string): RunObservationSnapshot | undefined
  readEvents(runId: string, afterSequence: number): RunObservationEvent[]
  listArtifacts(runId: string, filter?: ArtifactFilter): ArtifactDescriptor[]
  readRepresentation(runId: string, artifactId: string, role: string): ArtifactRepresentationRef
}
```

Interface 约束：

- `RunObservationChange` 是 typed union，不接受任意 event name + metadata bag。
- `publishArtifact()` 接收明确 scope 与 profile input，调用者不拼正式路径。
- `readRepresentation()` 只返回 `complete` representation。
- filesystem 是 local-substitutable dependency；测试直接使用临时目录，不在 external interface 暴露 storage port。
- HTTP/SSE/WebSocket 只是读取 interface 的 Adapter，不把 transport 语义塞进 Module。

### 3.3 职责分工

| Owner | 职责 | 不负责 |
| --- | --- | --- |
| Kernel | run/unit/attempt lifecycle、retry/resume、accepted attempt | 文件复制、格式转换、前端查询 |
| Runtime | 选择 canonical profile、提供科学语义、接受 canonical result | run scheduling、前端推断 |
| Driver/Python worker | 控制设备、生成 source files、返回验证过的设备事实 | 正式 run 目录、accepted attempt、前端 schema |
| Run Records Module | 固定路径、descriptor、normalization、checksum、原子发布、snapshot/event/index 投影 | 研究规划、硬件控制 |
| Backend Adapter | 将读取 interface 暴露给前端 | 扫描目录、解释 driver payload |
| Frontend | 展示 snapshot、events 和 canonical representations | 解析文件名、转换 source file、猜 accepted attempt |

## 4. Run Observation Contract

### 4.1 Snapshot

MVP snapshot 包含本次 run 的全部 unit summaries；典型 10×10 mapping 只有 100 units，暂不分页。

```ts
type RunObservationSnapshot = {
  schemaVersion: 1
  runId: string
  throughSequence: number
  status: "queued" | "running" | "paused" | "aborted" | "failed" | "completed"
  progress: {
    completedUnits: number
    failedUnits: number
    totalUnits: number
  }
  units: UnitObservation[]
  heartbeatAt?: string
  errorState?: RuntimeError
  startedAt: string
  updatedAt: string
  endedAt?: string
}

type UnitObservation = {
  unitId: string
  index: number
  point?: { row?: number; col?: number; xUm: number; yUm: number; zUm?: number }
  status: "pending" | "running" | "waiting_retry" | "succeeded" | "failed" | "cancelled"
  activeAttemptId?: string
  acceptedAttemptId?: string
  attemptCount: number
  canonicalArtifactIds: string[]
  startedAt?: string
  endedAt?: string
}
```

`succeeded` 必须具有 `acceptedAttemptId`。mapping 某点失败但 run 继续时，该 unit 仍是 `failed`；因 run abort 而不再执行的 unit 是 `cancelled`。

### 4.2 Ordered Events

每个 run 使用从 1 开始、严格单调递增的 `sequence`：

```ts
type RunObservationEvent = {
  schemaVersion: 1
  sequence: number
  eventId: string
  runId: string
  timestamp: string
  change: RunObservationChange
}
```

MVP change types 至少包括：

- run status changed
- unit status changed
- attempt started / finished / accepted
- artifact lifecycle changed
- heartbeat updated

Snapshot 与 `artifact-index.json` 使用 `throughSequence` 表示已经包含到哪条 event，不再各自维护无关 revision。

Events 不是唯一业务真相。前端发现 sequence gap 或 cursor 失效时重新读取 snapshot；MVP 不建设完整 event-sourcing replay 平台。

### 4.3 Backend read Adapter

具体 transport 后续选择，但读取能力固定为：

```text
read current run snapshot
read events after sequence
list/filter run artifacts
read one artifact descriptor
stream one complete representation
```

后端请求期间禁止扫描 artifact 目录。artifact listing 使用 run-level index。

## 5. Artifact Contract

### 5.1 Descriptor envelope

```ts
type ArtifactDescriptor = {
  schemaVersion: 1
  artifactId: string
  scope:
    | { kind: "run"; runId: string; unitId: string; attemptId: string; actionId: string }
    | { kind: "operator"; operationId: string; relatedRunId?: string; actionId: string }
  layer: "source" | "canonical" | "diagnostic"
  profile?: "raman-frame" | "raman-spectrum" | "raman-autofocus" | "raman-evaluation"
  status: "pending" | "producing" | "complete" | "failed"
  sourceArtifactIds: string[]
  representations: ArtifactRepresentation[]
  createdAt: string
  completedAt?: string
  error?: { errorCode: string; message: string }
}

type ArtifactRepresentation = {
  role: "data" | "display" | "thumbnail" | "download" | "source" | "diagnostic"
  mediaType: string
  path: string
  byteSize: number
  checksum: { algorithm: "sha256"; digest: string }
}
```

Profile 可以进一步限制 allowed roles。调用者不能自行发明 role 或把任意 driver payload 填入 descriptor。

### 5.2 Lifecycle 与发布

```text
pending -> producing -> complete
                     -> failed
```

发布顺序：

1. 分配 artifact ID 与正式 scope。
2. 在 staging path 复制/生成 representations。
3. 验证 source、scientific semantics 与 profile schema。
4. 计算 byte size 与 SHA-256。
5. 原子 rename 到 artifact final path。
6. 写入不可变 complete descriptor。
7. 更新 artifact index、snapshot/event projection。
8. 全部成功后才允许清理 bridge/daemon staging。

如果进程在正式发布前中断：

- artifact 变为 `failed`，errorCode 为 `publication_interrupted`
- staging 被保留或移到 recovery/diagnostic 位置
- restart 不根据文件存在猜测成功
- resume/retry 创建新 attempt 与新 artifact IDs

### 5.3 固定目录

```text
lab-records/
├── runs/
│   └── <runId>/
│       ├── run-state.json
│       ├── run-observation.json
│       ├── events.jsonl
│       ├── artifact-index.json
│       └── artifacts/
│           └── units/
│               └── <unitId>/
│                   └── attempts/
│                       └── <attemptId>/
│                           └── <artifactId>/
│                               ├── descriptor.json
│                               └── representations/
└── operator-operations/
    └── <operationId>/
        ├── operation.json
        ├── artifact-index.json
        └── artifacts/
            └── <artifactId>/
                ├── descriptor.json
                └── representations/
```

所有 ID 必须是 path-safe immutable segment。`ExecutionUnit.artifactPathPrefix` 不再由 compiler 或调用者拼接；Run Records Module 根据 scope IDs 生成路径。

### 5.4 Artifact index

`artifact-index.json` 是原子更新、可重建的查询投影：

- 记录 artifact identity、lifecycle、profile、unit/attempt ownership 和 descriptor path
- 通过 `throughSequence` 与 snapshot/events 对齐
- API 使用 index 做 listing/filtering
- index 不取代每个 artifact 自包含的 `descriptor.json`
- 丢失时从 RunState、events 和 completed descriptors 重建，不要求完整 event sourcing

## 6. Raman MVP Canonical Profiles

MVP 只固定四种 profile。

### 6.1 `raman-frame`

Representations：

- `display`: full-resolution lossless PNG
- `thumbnail`: bounded-size WebP

Source TIFF 作为独立 Source Artifact 保存。Descriptor data 至少记录 width、height、source bit depth、color model、capturedAt、sourceArtifactIds 与 verified laser state。

requested laser state 不是 verified state。worker 未返回可验证证据时，`laserState` 必须是 `unknown`，不能写成 `off`。

### 6.2 `raman-spectrum`

Representations：

- `data`: versioned JSON
- `download`: UTF-8 CSV

JSON 至少包含：

- x axis kind / unit / values
- y axis kind / unit / values
- acquisition settings
- derived metrics

CSV 使用 profile-defined、带单位的 headers。MVP 的 canonical Raman spectrum 必须明确 Raman shift `cm^-1` 与 intensity unit；若 source 无法证明 scientific axes，保留 Source Artifact，但 canonicalization 失败。

Spectrum plot 由前端从 JSON 绘制；PNG plot 不是权威 canonical result。

### 6.3 `raman-autofocus`

Representation：

- `data`: versioned JSON

JSON 包含 scan points、peak estimate、selected focus / selection source、final verification、confidence diagnostics、parameters 和 algorithm version。

它引用两张独立 canonical `raman-frame`：

- pre-focus frame
- accepted-focus frame

中间 Z sample frames 保留为 Source/diagnostic Artifacts，不全部提升为 canonical results。

### 6.4 `raman-evaluation`

Representation：

- `data`: versioned JSON

JSON 包含 rule-set id/version、input artifact IDs/metrics、thresholds、逐条 rule comparison、decision 与 reasons。Evaluation 只引用同一 attempt 的 inputs，完成后不可被未来配置静默重算覆盖。

## 7. 当前实现状态

MVP 已实现 Run Records Module、atomic descriptor/index、ordered events、fixed artifact hierarchy、
四种 Raman canonical profiles、same-run retry/resume、read adapter 与 operator operation scope。
Python daemon 只保留硬件 session；run action 通过显式 `artifactContext` 提供 staging identity，
daemon 不再从 stage move 推断 run/point ownership。laser-off 与 scientific axes 均 fail closed。

当前仍有一个有意保留的过渡 projection：既有 agent tools 继续写 `RunState.artifactRefs`、
`legacy-events.jsonl` 与 `artifacts.jsonl`。前端不得读取这些 projection；其唯一观察面是
`RunRecordsReadAdapter`。移除该兼容 projection 仍是 Phase 11 的未完成清理项，详见
`implementation-plan.md` checklist。

## 8. 分阶段实现计划

每个阶段必须形成可验证纵向增量；不一次性重写所有 stores/runtime。

### Phase A — Simulation Observation Vertical Slice

**目标**：先通过 simulation 建立 Run Records Module seam。

**实现**：

- 新建 observation/artifact schemas
- 新建固定 layout 与 atomic JSON writer
- 实现 `initializeRun`、`applyRunChange`、`readRun`、`readEvents`
- Snapshot 包含全部 unit summaries
- Events 使用 monotonic sequence
- mapping retry 产生 immutable attempts 与 explicit acceptedAttemptId
- 后端读取 Adapter 先以 in-process interface 验证，不选 SSE/WebSocket

**替换**：

- run-controller 不再直接分别写 snapshot/event store
- 旧 run/event stores 收进 Module implementation 或删除

**验证**：

- simulation 10×10 snapshot
- unit 六状态迁移
- retry 不覆盖、accepted attempt 明确
- sequence gap 后重新读取 snapshot

**退出条件**：前端测试 consumer 只通过读取 interface 即可重建 simulation run 进展。

### Phase B — Atomic Artifact Publication

**目标**：实现与 Raman 无关的正式 artifact publication pipeline。

**实现**：

- `publishArtifact()` 与 Artifact Descriptor v1
- fixed run/unit/attempt/artifact hierarchy
- source/canonical/diagnostic layers
- lifecycle events、artifact index 与 throughSequence
- staging、byte size、SHA-256、atomic rename
- interrupted publication reconciliation
- fake canonical profile 用于测试

**替换**：

- `artifact-store.ts` append-only `ArtifactRef` 路径
- runtime 中的通用 copy/path/index 逻辑

**验证**：

- partial write 不可读取
- checksum mismatch 失败
- publish crash 标记 `publication_interrupted`
- index 可由持久事实重建

**退出条件**：simulation artifact 能通过同一个 Module 完成生产、查询和读取。

### Phase C — Raman Single-Point Canonical Profiles

**目标**：跑通真实/假 Raman 单点的固定前端结果格式。

**实现**：

- Python adapter 返回 typed source candidates 与 verified device facts
- `raman-frame` PNG/WebP normalization
- `raman-spectrum` JSON/CSV normalization 与 scientific axis validation
- `raman-autofocus` JSON + pre/accepted frame links
- `raman-evaluation` complete rule evidence JSON
- laser-off worker result 必须返回 verified state；否则 `unknown` 或 action failure

**替换**：

- `scopeRuntimeArtifacts()`
- `persistAutofocusArtifact()` / `persistEvaluationArtifact()` 的散落文件写入
- spectrum plot 作为正式 canonical artifact 的行为

**验证**：

- source + canonical provenance
- 缺单位 spectrum canonicalization fail closed
- 缺 laser verification 不报告 laser off
- 四个 profile schema 与 representation checksum

**退出条件**：单点 run 的 snapshot 和四类 canonical artifacts 可由前端 consumer 稳定读取。

### Phase D — Mapping Retry And Resume Consistency

**目标**：把同 runId、多 attempts、resume 的文件一致性跑通。

**实现**：

- kernel 为每次 execution 分配显式 path-safe attemptId
- retry/resume 保留 runId，创建新 attempt
- unit 状态 `waiting_retry` 与 acceptedAttemptId
- Python request 携带明确 run/unit/attempt/action staging context
- daemon 删除基于最近 stage move 的 formal run/point inference
- mapping artifacts 全部进入明确 attempt scope

**验证**：

- immediate retry、final retry、pause/resume
- failed attempts 保留且不进入默认 result
- accepted attempt 对应 canonical result
- daemon 跨 run/operator 复用时无 artifact 混写

**退出条件**：真实或 faux runtime 的 mapping retry/resume 不覆盖、不错配、不串 run。

### Phase E — Backend Read Adapter And Operator Scope

**目标**：完成前端所需最小读取面，并隔离 operator artifacts。

**实现**：

- snapshot read
- events-after-sequence read
- artifact list/filter/detail/representation read
- operator operation IDs 与独立目录/index
- optional relatedRunId，仅用于展示关联
- API contract tests；transport 保持最小实现

**验证**：

- 前端 fixture consumer 不读 filesystem
- active run mapping grid + artifact result navigation
- operator frame/autofocus/smoke spectrum 不写入最近 run
- event gap 回退 snapshot

**退出条件**：前端可以只依赖 Backend Adapter 完成 MVP 的进展与结果观察。

## 9. MVP 端到端验收场景

1. **Single point success**：同一 attempt 下生成 frame、spectrum、autofocus、evaluation canonical profiles。
2. **Mapping retry recovery**：初次失败与 retry artifacts 都保留，unit 只接受成功 attempt。
3. **Pause/resume**：runId 不变，重新执行产生新 attempt，旧证据不覆盖。
4. **Canonical failure**：source spectrum 保留，但缺 scientific units 时 canonical artifact failed 且前端不可绘制。
5. **Interrupted publication**：半文件不发布，restart 后旧 artifact failed，新 attempt 可继续。
6. **Laser-off frame**：只有 verified worker evidence 才展示 laser off；requested-only 显示 unknown/failure。
7. **Operator operation**：maintenance artifact 使用 operationId，不进入 active/previous run accepted results。
8. **Frontend recovery**：sequence gap 后重新读取 snapshot，mapping grid 与 accepted results 恢复一致。

## 10. 实施纪律

- 先完成 Phase A simulation，再触碰真实 Raman artifact conversion。
- 每阶段替换旧写入点，不在旧 stores/runtime 上长期叠兼容层。
- 新测试通过 `Run Records Interface` 验证 observable outcomes，不测试内部路径 helper。
- filesystem tests 使用临时目录；Python daemon tests 使用 faux process/worker，不调用真实设备。
- 每阶段代码完成后运行相关测试与 `npm run check`。
- 若实现需要超出本文的 MVP 非目标，先回到设计文档确认，不顺手扩 scope。
