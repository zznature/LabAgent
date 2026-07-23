# Run Observation 与 Artifact Contract

本文回答一个问题：

> LabAgents 如何以固定位置、固定格式保存实验产物，并通过稳定的后端 interface 让前端观察 run 进展与结果？

本文整合 `docs/adr/0001` 至 `0027` 已确认的决策。ADR 保留决策历史，本文是实现时优先阅读的综合技术方案。

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
- Artifact lifecycle 不决定 run lifecycle；`failed` descriptor 是可观察的数据事实，不等于 run terminal failure。

### 2.3 Source 与 Canonical

- Driver / Python worker 产生 Source Artifact 或 source path。
- bridge / daemon 路径只是 staging，不是正式实验记录位置。
- Runtime 对 Canonical Artifact 的科学语义、schema 校验和接受负责。
- Source Artifact 保留设备原始证据；Canonical Artifact 提供前端稳定格式。
- Canonical Artifact 必须记录其 Source Artifact provenance。
- 正式 representations 全部记录 byte size 与 SHA-256。
- Source Artifact 归档失败使当前 attempt 成为 point-level data failure；Canonical Artifact 失败只降低结构化分析能力。

### 2.4 Operator operation

- 不属于 bounded run 的 operator frame/autofocus/smoke spectrum 使用独立 `operationId`。
- operator operation 可记录 `relatedRunId`，但不能写入该 run 的正式 artifact scope。
- 只有 kernel-owned Execution Attempt 能产生 bounded run 的 accepted result。

## 3. Deep Module 设计

### 3.1 Module 与 seam

系统使用一个 `Run Records Module`。它的 seam 位于：

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

写入 interface 以当前实现导出的 TypeScript 类型为准：

```ts
interface RunRecords {
  initializeRun(input: InitializeRunInput): RunObservationSnapshot
  applyRunChange(runId: string, change: RunObservationChange): RunObservationSnapshot
  initializeOperatorOperation(input: {
    operationId: string
    operationKind: string
    relatedRunId?: string
    startedAt: string
  }): void
  publishArtifact(input: ArtifactPublicationInput): ArtifactDescriptor
  recoverInterruptedPublications(runId: string): ArtifactDescriptor[]
  readRun(runId: string): RunObservationSnapshot | undefined
  readEvents(runId: string, afterSequence: number): RunObservationEvent[]
  listArtifacts(runId: string, filter?: ArtifactFilter): ArtifactDescriptor[]
  readArtifact(runId: string, artifactId: string): ArtifactDescriptor | undefined
  listOperatorArtifacts(operationId: string): ArtifactDescriptor[]
  readOperatorArtifact(operationId: string, artifactId: string): ArtifactDescriptor | undefined
  readRepresentation(runId: string, artifactId: string, role: string): ReadRepresentationResult
  readOperatorRepresentation(operationId: string, artifactId: string, role: string): ReadRepresentationResult
}
```

后端 consumer 使用 `RunRecordsReadAdapter`，其只读方法与上面对应的 `read*` / `list*` 方法一致。

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
  artifactIndex?: {
    status: "degraded"
    errorCode: "artifact_index_update_failed"
    message: string
  }
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

`heartbeat updated` 必须同时推进 ordered event 与 snapshot 的 `heartbeatAt`；terminal failure
必须把结构化 `RuntimeError` 投影到 snapshot 的 `errorState`。前端不读取 legacy `RunState`
才能获得这两类运行事实。
MVP 在 unit/action checkpoint 写 heartbeat，并在长 runtime action 等待期间每秒续写一次，
因此 liveness 不依赖 action 何时返回。

Snapshot 与 `artifact-index.json` 使用 `throughSequence` 表示已经包含到哪条 event，不再各自维护无关 revision。

Events 不是唯一业务真相。前端发现 sequence gap 时重新读取 snapshot；MVP 不建设完整 event-sourcing replay 平台。

### 4.3 Backend read Adapter

无论使用何种 transport，读取能力固定为：

```text
read current run snapshot
read events after sequence
list/filter run artifacts
read one artifact descriptor
stream one complete representation
```

正常后端请求期间禁止扫描 artifact 目录，artifact listing 使用 run-level index。唯一例外是
snapshot 已标记 `artifactIndex.status = "degraded"`，或 index 缺失、损坏、引用失效时，
Run Records Module 可在内部扫描自包含 descriptor 重建读取视图；Backend Adapter 与前端仍不得扫描目录。

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

同一 attempt 内每个可重复的 artifact-producing action 必须拥有稳定且互不冲突的 `actionId`。
特别是多次 `capture_frame` 不能共享通用的 `frame` artifact identity；其 identity 至少区分 action 顺序，
并可附带 `pre_focus`、`post_focus` 或 `observation` role。role 是科学语义，action 顺序负责唯一性，
两者都不能依赖文件名反推。MVP 的 live execution contract 对每个 unit 只允许一个 autofocus
和一个 acquire_spectrum；显式 focus evidence role 还必须位于该 autofocus 的正确一侧。

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

这里的 fail-closed 只作用于单个 Artifact：失败或中断的 Artifact 不能被读取为完整证据。
Runtime 不得把 `failed` canonical descriptor 抛成 run-control 异常。若 Source Artifact 未能归档，
kernel 将 attempt 记录为 `data.source_artifact_unavailable` 并按冻结 retry policy 处理；重试耗尽后 point
失败但 mapping 继续。若 Source Artifact 已完整保存而 canonicalization 因列语义、格式、schema 或
representation 失败，attempt 仍可被接受，其 `canonicalArtifactIds` 只包含实际 `complete` 的 Canonical Artifacts。

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
- 原子写入统一使用唯一临时文件；只有 artifact index 的 Windows rename 明确返回 `EPERM` 时执行有界重试
- descriptor 与必要 observation 已经持久化后，index 更新失败只把查询投影标记为 `degraded`，不得终止 bounded run
- `degraded` 时 Run Records Module 从 descriptor 重建读取视图；前端仍只调用读取 interface，不直接扫描目录
- descriptor、representation 或必要 observation/event 写入失败仍属于不可降级的持久化失败

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

Run Records Module 会验证两条引用均指向同一 run/unit/attempt 下已经 complete 的
`raman-frame`；空引用、跨 attempt 引用或未完成 frame 都使 autofocus publication fail closed。

中间 Z sample frames 保留为 Source/diagnostic Artifacts，不全部提升为 canonical results。

### 6.4 `raman-evaluation`

Representation：

- `data`: versioned JSON

JSON 包含 rule-set id/version、input artifact IDs/metrics、thresholds、逐条 rule comparison、decision 与 reasons。Evaluation 只引用同一 attempt 的 inputs，完成后不可被未来配置静默重算覆盖。

## 7. 使用说明

实现入口位于：

- `src/extensions/experiment-research/records/run-records.ts`：写入、投影、发布、恢复与底层读取
- `src/extensions/experiment-research/records/read-adapter.ts`：后端提供给 consumer 的只读 interface
- `src/extensions/experiment-research/store/layout.ts`：Module 内部使用的固定文件布局

调用者应依赖 `RunRecords` 或 `RunRecordsReadAdapter`，不得依赖具体文件路径。HTTP、SSE 或
WebSocket adapter 可以包装读取 interface，但不得改变本节定义的查询语义。

### 7.1 创建并更新 run observation

Kernel 在 run 启动前初始化 observation：

```ts
const records = createRunRecords(cwd)

records.initializeRun({
  runId,
  experimentId,
  procedureSpecId,
  startedAt,
  units: executionUnits.map((unit) => ({
    unitId: unit.unitId,
    index: unit.index,
    point: unit.point,
  })),
})
```

运行期间只通过 typed change 更新状态：

```ts
records.applyRunChange(runId, { type: "run_started", timestamp })
records.applyRunChange(runId, { type: "heartbeat_updated", timestamp })
records.applyRunChange(runId, {
  type: "attempt_started",
  unitId,
  attemptId,
  timestamp,
})
```

一次 attempt 成功后，Kernel 必须明确接受它并写入该 attempt 的 canonical artifact IDs：

```ts
records.applyRunChange(runId, {
  type: "attempt_accepted",
  unitId,
  attemptId,
  canonicalArtifactIds,
  timestamp,
})
```

失败且需要重试时使用 `attempt_failed` 并令 `willRetry: true`。retry / resume 继续使用原
`runId`，但必须创建新的 `attemptId`；旧 attempt 的 descriptor 与 representations 保持不变。

### 7.2 发布 artifact

Runtime 或 driver bridge 先产生 source file，再由 Runtime 通过 `publishArtifact()` 发布。调用者提供
artifact identity、scope、layer、profile 与候选内容，不拼接正式保存路径。

Source Artifact 示例：

```ts
const source = records.publishArtifact({
  artifactId,
  scope: { kind: "run", runId, unitId, attemptId, actionId },
  layer: "source",
  sourceArtifactIds: [],
  createdAt,
  representations: [{
    role: "source",
    mediaType: "image/tiff",
    fileName: "frame.tiff",
    sourcePath,
  }],
})
```

Canonical Artifact 必须引用同一 run/unit/attempt 中已经 `complete` 的 Source Artifacts：

```ts
const spectrum = records.publishArtifact({
  artifactId,
  scope: { kind: "run", runId, unitId, attemptId, actionId },
  layer: "canonical",
  profile: "raman-spectrum",
  sourceArtifactIds: [source.artifactId],
  createdAt,
  canonicalData: {
    schemaVersion: 1,
    xAxis: { kind: "raman_shift", unit: "cm^-1", values: shifts },
    yAxis: { kind: "intensity", unit: intensityUnit, values: intensities },
    acquisition,
    metrics,
  },
})
```

`publishArtifact()` 完成 staging、profile validation、复制或生成 representations、byte size、SHA-256、
descriptor、原子发布、event 和 index 更新。返回 `failed` descriptor 时，调用者不得把该 artifact
加入 `attempt_accepted.canonicalArtifactIds`，也不得仅因该 canonical descriptor 失败而终止 run。
Source descriptor 失败则由 runtime 返回 typed `source_artifact_unavailable`，由 kernel 记录、重试并继续调度。

### 7.3 后端读取 run 进展

后端使用只读 adapter：

```ts
const backend = createRunRecordsReadAdapter(cwd)
const snapshot = backend.readRun(runId)
if (!snapshot) {
  throw new Error(`run not found: ${runId}`)
}
const cursor = snapshot.throughSequence
const events = backend.readEvents(runId, cursor)
```

前端首次进入 run 页面时读取 snapshot，以 `snapshot.throughSequence` 作为 event cursor，随后请求
`readEvents(runId, cursor)` 获取增量变化。事件 sequence 必须连续；发现 gap 或本地状态
无法解释时，丢弃本地 projection 并重新读取 snapshot。

页面状态的权威来源固定为：

- run lifecycle：`snapshot.status`
- 总进度：`snapshot.progress`
- mapping grid：`snapshot.units[].point` 与 `status`
- 当前执行：`activeAttemptId`
- 正式采用的执行：`acceptedAttemptId`
- 正式结果：`canonicalArtifactIds`
- liveness：`heartbeatAt`
- terminal failure：`errorState`

前端不得通过 artifact 数量、最大 attempt 编号、文件修改时间或目录名称推断上述状态。

### 7.4 读取 accepted results

`listArtifacts(runId)` 返回所有 layers、attempts 和 lifecycle 状态，适合历史、诊断和 provenance
页面，不等同于正式结果列表。默认结果页面应从 succeeded unit 的
`canonicalArtifactIds` 出发：

```ts
const acceptedDescriptors = snapshot.units
  .filter((unit) => unit.status === "succeeded")
  .flatMap((unit) => unit.canonicalArtifactIds)
  .map((artifactId) => backend.readArtifact(runId, artifactId))
  .filter((artifact) => artifact?.status === "complete")
```

需要查询历史或诊断数据时使用 server-side filter：

```ts
backend.listArtifacts(runId, {
  unitId,
  attemptId,
  layer: "canonical",
  profile: "raman-spectrum",
  status: "complete",
})
```

### 7.5 读取与渲染 representation

前端根据 `descriptor.profile` 选择结果组件，根据 representation `role` 选择内容；不得根据文件名
或扩展名推断科学语义。

| Profile | Role | Media type | Consumer 行为 |
| --- | --- | --- | --- |
| `raman-frame` | `display` | `image/png` | 显示全分辨率图像 |
| `raman-frame` | `thumbnail` | `image/webp` | 显示列表或网格缩略图 |
| `raman-spectrum` | `data` | `application/json` | 使用 axis values 绘制 spectrum |
| `raman-spectrum` | `download` | `text/csv` | 提供带单位 CSV 下载 |
| `raman-autofocus` | `data` | `application/json` | 显示扫描点、选择结果与两张代表 frame |
| `raman-evaluation` | `data` | `application/json` | 显示规则、阈值、decision 与 reasons |

读取示例：

```ts
const representation = backend.readRepresentation(runId, artifactId, "data")
const data = JSON.parse(representation.bytes.toString("utf8"))
```

Transport adapter 应使用 `representation.mediaType` 作为响应 `Content-Type`，直接传输 bytes；不要
把 `Buffer` 包进 JSON。`readRepresentation()` 会拒绝未完成的 artifact、未知 role、缺失文件以及
byte size 或 SHA-256 不匹配的内容。

### 7.6 读取 autofocus 关联 frame

读取 `raman-autofocus` 的 `data` representation 后，从
`frameArtifactIds.preFocus` 与 `frameArtifactIds.acceptedFocus` 获得两张 canonical
`raman-frame` 的 artifact IDs，再分别读取其 `display` 或 `thumbnail` representation。不要从
autofocus source 文件或文件名推断代表帧。

### 7.7 Operator operation

不属于 bounded run 的维护操作先建立独立 operation：

```ts
records.initializeOperatorOperation({
  operationId,
  operationKind,
  relatedRunId,
  startedAt,
})
```

其 artifacts 使用 `{ kind: "operator", operationId, relatedRunId, actionId }` scope 发布，并通过：

```ts
backend.listOperatorArtifacts(operationId)
backend.readOperatorArtifact(operationId, artifactId)
backend.readOperatorRepresentation(operationId, artifactId, role)
```

读取。`relatedRunId` 只用于 UI 展示关联；operator artifacts 不得合并进 run 的 accepted results。

### 7.8 恢复与错误处理

Workspace 启动时调用 `recoverWorkspaceInterruptedPublications(cwd)`。中断的 staging publication 会被
记录为 `failed`，并带有 `publication_interrupted` error；恢复逻辑不会因为目标文件存在而猜测
artifact 已成功。后续 retry 使用新 attempt 和新 artifact IDs。

Consumer 对失败的处理原则：

- `readRun()` 返回 `undefined`：run 不存在
- `readArtifact()` 返回 `undefined`：artifact 不存在或不在 index 中
- descriptor `status: "failed"`：展示 `error`，不读取 representation
- representation 读取抛出带有 not found、not complete 或 checksum mismatch 信息的 `Error`；transport
  adapter 负责将其映射为对外错误响应
- event sequence gap：重新读取 snapshot，不自行补猜事件

所有前端和后端 consumer 都应只使用 `RunRecordsReadAdapter`。`run-state.json`、
`legacy-events.jsonl`、`artifacts.jsonl`、`artifact-index.json` 和 artifact 目录均属于 Module 内部
持久化实现，不是 consumer contract。
