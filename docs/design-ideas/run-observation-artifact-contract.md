# Run Observation And Artifact Contract

本文记录 `raman-mapping-controls` 当前分支已经实现的最小 run observation / artifact 边界。
它不复制 `main` 分支的 canonical Run Records、descriptor lifecycle 或 representation API。

## 1. 当前持久化边界

当前 run 使用：

```text
lab-records/runs/{runId}/
  run-state.json
  events.jsonl
  artifacts.jsonl
  ...
```

- `RunState` 保存当前运行快照和 `artifactRefs`
- `events.jsonl` 保存 append-only run events
- `artifacts.jsonl` 保存 append-only `{ runId, recordedAt, artifact }`
- `ArtifactRef` 最小字段为 `artifactId / kind / path`，可选 `label / metadata`
- artifact payload 文件位于对应 run root 下

`artifacts.jsonl` 是索引，不代替 payload 文件；payload 文件也不能脱离 ArtifactRef 让上层按目录猜测。

## 2. Autofocus evidence

live calibration 的每个 waypoint / anchor 都会保存一个 `raman-autofocus` JSON：

```ts
type RamanAutofocusArtifact = {
  unitId: string
  status: "success" | "failed" | "paused"
  summary: string
  errorCode?: string
  payload: {
    zBestUm?: number
    confidence?: number
    [key: string]: unknown
  }
}
```

恢复下一 calibration unit 时，runtime 从当前 run 的 artifact records 逆序查找最近一个
`status = success` 且具有有限 `payload.zBestUm` 的 `raman-autofocus`，不依赖 daemon 内存。

waypoint autofocus 是导航与恢复证据。只有 `focusCalibration.sampleRole = "anchor"` 且具有
`anchorId = center | corner_1..4` 的五个 unit 进入平面拟合。

## 3. `raman-focus-plane`

最终 anchor unit 完成 autofocus 后，TypeScript live runtime 读取同一 run 的五个 accepted anchor
artifacts，拟合 `Z = aX + bY + c`，并创建：

```text
lab-records/runs/{calibrationRunId}/focus-plane.json
```

当前 payload 形状：

```ts
type RamanFocusPlaneArtifact = {
  profile: "raman-focus-plane"
  calibrationRunId: string
  procedureSpecId: string
  anchors: Array<{
    anchorId: "center" | "corner_1" | "corner_2" | "corner_3" | "corner_4"
    xUm: number
    yUm: number
    zUm: number
    confidence?: unknown
  }>
  model: {
    a: number
    b: number
    c: number
    rmsErrorUm: number
    maxAbsErrorUm: number
    anchorCount: 5
  }
  validRegion: Array<{
    anchorId: "corner_1" | "corner_2" | "corner_3" | "corner_4"
    xUm: number
    yUm: number
  }>
}
```

对应 `ArtifactRef`：

```ts
{
  artifactId: `${calibrationRunId}-focus-plane`
  kind: "raman-focus-plane"
  path: "focus-plane.json"
  metadata: {
    checksum: `sha256:${digest}`
    anchorCount: 5
    rmsErrorUm: number
  }
}
```

live publication 使用 exclusive create；同一路径已存在时只读取并重新计算 checksum，不覆盖模型。
simulation runtime 发布相同核心字段，并额外标记 `simulated: true`。

当前分支没有把 `raman-focus-plane` 注册为 `main` 中的 canonical profile，也没有 source /
representation descriptor。这里的 `profile` 是 payload 自描述字段，`kind` 是当前 ArtifactRef 类型。

## 4. 跨 run 引用

校正 mapping 的冻结 spec 保存：

```ts
{
  kind: "focus_plane"
  calibrationRunId: string
  artifactId: string
  checksum: string
  coefficients: { a: number; b: number; c: number }
  validRegion: Array<{ anchorId: string; xUm: number; yUm: number }>
  localAutofocusHalfRangeUm: 40
}
```

preflight、simulation runtime 和 live runtime 都按 `calibrationRunId + artifactId` 定位原 Artifact，
并重新验证：

- ArtifactRef `kind = raman-focus-plane`
- payload `profile = raman-focus-plane`
- payload `calibrationRunId` 与引用一致
- 文件 SHA-256 与冻结 checksum 一致
- payload model coefficients 与冻结 coefficients 完全一致
- payload validRegion 与冻结 validRegion 完全一致

任一检查失败时返回 `focus_plane_artifact_missing` 或 `focus_plane_artifact_mismatch`，不得静默退回固定 Z。
runtime 不按时间戳或目录扫描推断“最近一次模型”。

## 5. 当前保证与后续边界

当前实现保证：

- calibration 和 mapping 分属不同 run 和 approval
- 五点证据与 waypoint evidence 分离
- live calibration 模型 payload 不可覆盖
- mapping 对原模型做 identity / checksum / coefficients / region 校验
- mapping 点必须位于 calibrated convex region

当前实现尚未声明：

- sample identity
- stage coordinate-frame identity
- algorithm version
- canonical representation lifecycle
- source artifact 与 normalized representation 分层
- 独立的 condition metric 或 residual acceptance threshold

这些字段如果未来随 `main` 的 Run Records 架构迁入，应作为新的明确增量实现并同步 validator；
不能只把目标字段写进本文档而让当前 artifact 假装已经提供。
