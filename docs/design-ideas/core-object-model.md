# LabAgents 核心对象模型

本文定义 `ExperimentIntent -> ProcedureSpec -> ExecutionUnit[] -> RunState` 的字段职责和事实边界。
精确可验证 schema 位于 `src/extensions/experiment-research/schemas/`；本文解释为什么这些对象存在，不复制实现源码。

## 1. 对象关系

```text
ExperimentIntent
  -> agent drafts ProcedureSpec
  -> proposal + approval freeze ProcedureSpec
  -> kernel compiles ExecutionUnit[]
  -> kernel/runtime produce RunState, events and artifacts
```

只有 `ExperimentIntent`、`ProcedureSpec` 和 `RunState` 是主链路交互对象。`ExecutionUnit[]` 是 kernel 派生对象；template、proposal、approval 和 artifact record 是辅助契约。

## 2. `ExperimentIntent`

`ExperimentIntent` 回答“用户想解决什么研究问题”，由用户输入和 agent 整理产生，供后续规划与 lineage 使用，不进入 kernel。

当前字段：

- identity：`intentId`、`experimentId`
- research framing：`objective`、`hypothesis?`、`question?`
- boundaries：`constraints?`、`successCriteria?`
- context：`evidenceRefs?`、`notes?`

它不包含 procedure steps、仪器驱动参数、运行状态或实验产物。

## 3. `ProcedureSpec`

`ProcedureSpec` 回答“这一次 bounded run 准备怎样执行”，是 agent 交给 kernel 的唯一声明式方案输入。

### 3.1 顶层职责

| 字段组 | 当前内容 |
| --- | --- |
| identity | `procedureSpecId`、`experimentId`、`intentId` |
| procedure | `procedureId`、`procedureVersion` |
| resources | 只引用 `{ resourceId, role }`，不内嵌 driver config |
| safety bounds | `limits`：laser ceiling、objective clearance、XYZ ranges |
| execution shape | `plan` |
| termination | `stoppingRules?`、`retryPolicy?` |
| domain parameters | typed `domain.raman` |

当前 `procedureId`：

- `raman_single_point_probe`
- `raman_parameter_search`
- `raman_grid_mapping`
- `raman_focus_plane_calibration`

### 3.2 当前 plan

| plan kind | 用途 | 关键边界 |
| --- | --- | --- |
| `current_position` | 未指定绝对点的单点运行 | 不用伪造绝对坐标表达当前位置 |
| `point_list` | 显式点列或直线生成器 | `points` 与 `generator` 二选一 |
| `grid_scan` | 规则网格 | 支持 row-major / snake 和点间等待 |
| `focus_plane_calibration` | 硬件采集焦平面 anchors | 冻结起点、seed、四角、中心与最大 XY span |

当前 semantic steps 只有：

- `move_to_point`
- `autofocus`
- `capture_frame`，可选 `laserOff`
- `acquire_spectrum`

`ProcedureSpec` 不支持任意 `if / for / while`，也不存在 `step_sequence`、`repeat_n` 或温控 step。

### 3.3 停止与重试

`stoppingRules` 当前可表达：

- `maxRuntimeMinutes`
- `maxUnits`
- `stopOnError`
- `maxConsecutiveFailures`

mapping 的可配置 `retryPolicy` 固定为 `immediate_then_final`：

- 点失败后可立即重试有限次数。
- 主扫描完成后，可按失败顺序进入 final retry queue。
- 当前可重试原因只有 execution timeout 与 low focus confidence。
- 每次 attempt 都进入 `RunState.pointAttempts`，失败历史不会被成功覆盖。

### 3.4 Raman domain

`domain.raman` 当前包含：

- autofocus enablement、ROI 与 strategy params
- acquisition 参数
- parameter-search envelope

硬件资源配置不属于 domain；planner template provenance 也不进入 spec。

### 3.5 Surface correction

`grid_scan` 与 `point_list` 可使用同一个 `surfaceCorrection`：

1. `focus_plane` + calibration artifact reference
   冻结 calibration run、artifact identity、checksum、模型、有效区域和 local autofocus range。

2. `focus_plane` + `manual_xyz_points`
   三个非共线 XYZ 点直接产生模型和三角形有效区域；这是一次性纯计算，不创建 run 或 artifact。

3. `disabled / user_declined`
   用户明确拒绝校正；每个 mapping 点必须有固定 Z。

由 operator 注册并持久化的三点模型走第一种 artifact-reference 路径，但 artifact 必须标记 `operator_supplied_xyz`，不能伪装成 runtime autofocus evidence。

## 4. `ExecutionUnit[]`

kernel 从冻结 `ProcedureSpec` 确定性编译 units。每个 unit 当前包含：

- stable identity：`unitId`、`index`、`resumeKey`
- shape：`unitKind`、`positionRef?`、`point?`
- work：ordered semantic `actions`
- enforcement：copied `limits`
- scheduling：`interUnitDelayMs?`
- evidence anchor：`artifactScope`
- calibration metadata：`focusCalibration?`

units 提供 progress、pause/resume、attempt 和 artifact naming 的稳定边界。planner 不直接编写 units；units 也不展开为 driver command。

当前编译规则：

- `current_position -> 1 point unit`
- `point_list -> N point units`
- `grid_scan -> rows × cols point units`
- `focus_plane_calibration -> progressive waypoint + 5 anchor units`

point-list line generator 在服务端展开，避免模型手写大量坐标与浮点漂移。

## 5. `RunState`

`RunState` 是 kernel 对“运行现在如何”的当前快照，由 kernel/runtime 写入，planner 不得预写。

字段职责：

- identity：`runId`、`experimentId`、`procedureSpecId`
- lifecycle：`executionMode?`、`status`
- progress：`progress`、`currentUnit?`、`heartbeatAt?`
- intervention：`pauseReason?`、`abortReason?`、`resumedFromUnitIndexes?`
- failure and quality：`errorState?`、`qualityState?`
- attempt history：`pointAttempts?`
- evidence index：`artifactRefs`
- timestamps：`startedAt`、`updatedAt`、`endedAt?`

状态集合固定为：

```text
queued | running | paused | aborted | failed | completed
```

`RunState` 只表达当前真相；append-only 历史属于 events，artifact payload 属于独立文件。

## 6. 辅助契约

### 6.1 `ExperimentProcedureTemplate`

template 是 workspace-local planner 参数先验，位于 `lab-config/templates/*.json`。

- 按 sample ID、sample class、intent keyword/tag 和 procedure default 匹配。
- 只提供 resources、limits、per-point actions、stopping/retry rules 和 domain defaults。
- 用户可以覆盖；proposal details 记录继承与覆盖字段。
- 不保存 experiment/run identity、历史坐标、approval 或 runtime state。

### 6.2 Proposal 与 approval

proposal store 持有完整 spec 和 SHA-256 `specHash`，状态为：

```text
proposed -> approved
         -> superseded
```

`approve_and_start_run` 只接收 `proposalId + specHash`；live run 还要求独立的 operator acknowledgement。`revise_proposal` 创建新 proposal，旧批准不继承。

### 6.3 Artifact

`ArtifactRef` 只索引 `artifactId / kind / path` 和可选 metadata；payload 保存在 run 目录。

跨 run 引用必须显式验证 identity、checksum 和领域关键字段。artifact index 不能代替 payload，message 也不能代替 artifact ref。

## 7. 持久化边界

```text
lab-records/
  experiments/{experimentId}/
    intents/*.json
    procedure-specs/*.json
    proposals/*.json
  runs/{runId}/
    run-state.json
    events.jsonl
    artifacts.jsonl
    artifact payloads...
```

最小不变量：

- 用户目标、agent 方案和运行事实分开保存。
- approved spec 是不可变运行输入。
- 当前快照与 append-only 历史分开。
- artifacts 记录实验产物，不充当任意业务状态数据库。
- resume 读取冻结 spec 与现有 `RunState`，不接受调用方重建运行真相。

## 8. Source 对照

- `schemas/experiment-intent.ts`
- `schemas/procedure-spec.ts`
- `schemas/execution-unit.ts`
- `schemas/run-state.ts`
- `schemas/experiment-procedure-template.ts`
- `schemas/tool-result.ts`
- `store/proposal-store.ts`
- `store/layout.ts`
