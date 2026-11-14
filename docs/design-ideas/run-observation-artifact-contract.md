# Run Observation 与 Artifact 契约

本文记录当前分支已经实现的 run records 与 Raman artifact provenance。它不声称提供完整审计系统或 canonical representation lifecycle。

## 1. 持久化布局

```text
lab-records/runs/{runId}/
  run-state.json
  events.jsonl
  artifacts.jsonl
  artifact payloads...
```

| 存储 | 职责 |
| --- | --- |
| `run-state.json` | 当前 `RunState` 快照与 artifact refs |
| `events.jsonl` | append-only lifecycle、unit、attempt 和等待事件 |
| `artifacts.jsonl` | append-only `{ runId, recordedAt, artifact }` 索引 |
| payload files | frame、spectrum、autofocus、focus-plane 等真实产物 |

`ArtifactRef` 最小字段为 `artifactId / kind / path`，可带 label/metadata。索引不代替 payload；payload 也不能脱离索引让上层扫描目录猜测。

## 2. Observation 规则

- `RunState` 表达当前状态，events 表达历史。
- heartbeat/progress 是结构化状态，不是 stdout 日志。
- 每次 mapping attempt 都记录 phase、status、failure、message 和 artifact IDs。
- run summary 直接带出 error state 或最近失败 attempt。
- paused/failed/completed/aborted 通过 terminal observer 主动回流。
- 大文件只通过 artifact ref 进入 agent 上下文。

## 3. Autofocus evidence

live calibration 的每个 waypoint/anchor 产生 `raman-autofocus` artifact，至少记录：

- unit identity
- `success / failed / paused`
- summary 与 optional error code
- `zBestUm`、confidence 等 payload

下一 calibration unit 从当前 run 的 artifact records 逆序寻找最近 accepted `zBestUm`，不依赖 daemon 内存。

waypoint evidence 只用于导航和恢复。只有 `focusCalibration.sampleRole = anchor` 且带命名 anchor ID 的中心与四角进入硬件校准平面拟合。

## 4. `raman-focus-plane`

### 4.1 Hardware calibration

最后一个 hardware anchor 完成后，TypeScript runtime 聚合同一 run 的五个 accepted anchors，拟合：

```text
Z = aX + bY + c
```

payload 包含：

- `profile = raman-focus-plane`
- calibration run/spec identity
- 五个 anchors
- coefficients、RMS 与最大残差、anchor count
- 四角 valid region

### 4.2 Operator-supplied calibration

operator 三点注册复用同一 profile，但必须包含：

- `source.kind = operator_supplied_xyz`
- exact operator confirmation
- 三个 anchors
- 三角形 valid region
- `anchorCount = 3`

它不包含伪造的 runtime evidence refs。

### 4.3 Publication

`focus-plane.json` 使用 exclusive create；已存在时不能覆盖模型。对应 `ArtifactRef.metadata` 保存 SHA-256、anchor count、fit diagnostics 和 optional source。

simulation 发布相同核心结构，并标记 simulated。

## 5. 跨 run 引用

artifact-backed mapping 冻结：

```text
calibrationRunId
artifactId
checksum
coefficients
validRegion
localAutofocusHalfRangeUm
```

New mapping defaults to `surfaceCorrection = disabled/default_disabled`; an explicit refusal remains `disabled/user_declined`. Missing correction is made explicit when a new proposal is stored, before hashing. Only explicitly enabled planes use the cross-run reference checks below. `localAutofocusHalfRangeUm` defaults to 40 um when omitted by planner helpers. Corrected mapping stores it on `surfaceCorrection.localAutofocusHalfRangeUm`; disabled mapping stores it on `domain.raman.autofocus.params.localAutofocusHalfRangeUm`. Once present in a mapping ProcedureSpec it is the approved local autofocus half-range and must not be inferred from `domain.raman.autofocus.params.fineHalfRangeUm`.

preflight、simulation 和 live runtime 重新验证：

- calibration run 已 completed
- artifact 同时存在于 artifacts index 和 completed `RunState`
- kind/profile 与 identity 一致
- payload checksum 与冻结 checksum 一致
- coefficients 与 valid region 完全一致

任一失败返回 missing/mismatch error；不得选择“最近一次模型”或退回 fixed Z。

operator artifact 可被多个 mapping runs 引用。当前没有 sample placement ID 或自动失效；样品移动后停止复用由 operator 负责。

## 6. 当前保证与缺口

已经保证：

- calibration 与 mapping 分属不同 run/approval
- waypoint 与 fit-anchor evidence 分离
- focus-plane payload 不可覆盖
- mapping 对 artifact identity 与完整性 fail closed
- mapping 点受冻结 valid region 约束

尚未保证：

- sample / coordinate-frame identity
- algorithm versioned provenance
- source artifact 与 normalized representation 分层
- canonical profile registry
- 独立 residual acceptance policy

这些能力需要新的 schema、validator 和迁移设计，不能只在 payload 中添加未经执行层保证的字段。
