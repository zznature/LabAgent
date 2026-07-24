# LabAgents MVP Rebuild Implementation Plan

本文把当前已经冻结的 MVP rebuild 路线，整理成适合 Codex goal 模型执行的实施计划。

目标不是一次性铺开全部功能，而是按一系列可验证的纵向增量推进，逐步完成：

```text
docs freeze
-> extension skeleton
-> core objects
-> persistence boundaries
-> unit compilation
-> simulation vertical slice
-> approval + freeze gate
-> planner proposal flow
-> explicit evaluation rules
-> Raman runtime contract
-> real supervised single-point Raman
-> bounded parameter search
-> bounded Raman mapping
```

## Planning Principles

整个 rebuild 过程遵循以下原则：

1. 每个 goal 都必须形成一个可验证增量，不做只铺结构不形成闭环的空转开发。
2. 优先做纵向切片，不做大面积横向重构。
3. `.pi/extensions/experiment-research` 是唯一 MVP implementation baseline；旧 reference implementation 已删除。
4. 新实现必须以 `docs/design-ideas/` 为权威设计来源。
5. 所有真实硬件执行都必须服从 supervised bounded run 边界。

## Definition Of Done

满足以下条件时，可以认为 MVP rebuild 基本完成：

- `experiment-research` extension 存在并可加载。
- 新架构不再以旧 extension 的 `ExperimentSpec` 体系为中心。
- 核心对象固定为三层：
  - `ExperimentIntent`
  - `ProcedureSpec`
  - `RunState`
- `ExecutionUnit` 作为 kernel 从 `ProcedureSpec` 派生的运行时对象，不列为第四个核心对象。
- bounded run lifecycle 可运行。
- simulation vertical slice 可运行。
- approval + freeze gate 可运行：未批准的 spec 不能执行，批准后 spec 冻结。
- supervised Raman single-point run 可运行。
- 两类明确危险（样品撞镜头、激光功率过高）在 runtime 层有硬限制。
- "good enough conditions" 使用显式规则。
- parameter search 是 bounded 的。
- mapping 是 bounded 的。
- 所有新的 effectful hardware run 都要求确认。
- run 内不允许热改 spec。
- 不允许无界自动搜索。

## Standard Per-Goal Workflow

每个 Codex goal 都建议按同一模板执行：

1. 先读与该 goal 直接相关的设计文档。
2. 明确本 goal 的 scope 与非 scope。
3. 只改与本 goal 直接相关的文件。
4. 添加最小必要测试。
5. 运行相关测试。
6. 在有代码改动后运行 `npm run check`。
7. 如实现与设计文档出现偏差，更新 `docs/design-ideas/`。
8. 记录遗留问题，但不顺手扩 scope。

## Phase 0: Freeze The Build Contract

### Objective

冻结 MVP rebuild 的产品与架构边界，避免实现过程中发生目标漂移。

### Scope

- 文档冻结
- 产品边界冻结
- 非目标清单冻结

### Checklist

- [x] 明确：
  - [x] agent can propose bounded runs
  - [x] agent can execute approved bounded runs
  - [x] agent cannot expand search unboundedly
  - [x] "good enough conditions" use explicit rules
- [x] `product_usage_example.md` 反映 phase-based supervised workflow
- [x] `AGENTS.md` 明确当前 extension 是唯一 MVP implementation baseline
- [x] 明确 MVP 暂不做：
  - [x] full watchdog policy
  - [x] generalized multi-device platform
  - [x] full Raman calibration lifecycle
  - [x] autonomous multi-run execution without approval

### Exit Criteria

- 文档已经足够约束开发。
- 后续 goal 不再需要反复澄清 MVP 边界。

### Suggested Codex Goal

`Freeze the MVP rebuild contract in docs for the supervised Raman multi-run workflow.`

## Phase 1: Create The Extension Skeleton

### Objective

创建 `.pi/extensions/experiment-research` 的最小扩展骨架，并保证能被加载。旧实现曾短期保留为 reference，现已删除。

### Scope

- 删除旧 reference implementation
- 新 extension 目录创建
- 最小入口文件
- 最小 tool registration wiring

### Checklist

- [x] 删除旧 reference implementation
- [x] 新建 `.pi/extensions/experiment-research/`
- [x] 添加最小文件：
  - [x] `package.json`
  - [x] `index.ts`
  - [x] `prompt.ts`
  - [x] `README.md`
- [x] 添加目录骨架：
  - [x] `schemas/`
  - [x] `planner/`
  - [x] `kernel/`
  - [x] `runtime/`
  - [x] `tools/`
  - [x] `store/`
  - [x] `test/`
- [x] `index.ts` 能注册最小 tool surface
- [x] prompt 分层固定为 `core lab agent prompt -> Raman extension prompt -> lab-local user prompts`
- [x] `src/prompts/APPEND_SYSTEM.md` 承载 core lab agent prompt
- [x] `src/extensions/experiment-research/prompt.ts` 承载 Raman extension prompt
- [x] 工作区 `lab-config/user-prompts.md` 承载 lab-local prompt，并在 extension prompt 后追加
- [x] 不复制旧 extension 的 dispatch / schema / kernel 结构

### Exit Criteria

- 新 extension 可加载。
- 目录结构稳定，可作为后续实现基线。

### Suggested Codex Goal

`Scaffold the experiment-research extension with minimal loading and tool registration.`

## Phase 2: Define The Core Objects

### Objective

实现 MVP 所需的核心对象模型：`ExperimentIntent`、`ProcedureSpec`、`ExecutionUnit`、`RunState`。

### Scope

- schema/type 定义
- 最小字段冻结
- 最小 plan kinds 和 semantic steps 冻结
- typed `domain` block 冻结

### Checklist

- [x] 在 `schemas/` 中定义：
  - [x] `experiment-intent.ts`
  - [x] `procedure-spec.ts`
  - [x] `execution-unit.ts`
  - [x] `run-state.ts`
  - [x] `tool-result.ts`
- [x] `ExperimentIntent` 最小字段可用
- [x] `ProcedureSpec` 最小字段可用
- [x] `ExecutionUnit` 最小字段可用
- [x] `RunState` 最小字段可用
- [x] 支持的 plan kinds：
  - [x] `grid_scan`
  - [x] `point_list`
  - [x] `focus_plane_calibration`
- [x] 支持的 semantic steps：
  - [x] `move_to_point`
  - [x] `autofocus`
  - [x] `capture_frame`
  - [x] `acquire_spectrum`
- [x] `domain.raman` typed block 承载 Raman 专有参数：
  - [x] `acquisition`（integrationTimeMs / laserPowerPercent / accumulations 等）
  - [x] `autofocus`（ROI / strategy params）
- [x] `limits` 与 `stoppingRules` 有最小结构

> 注：`apply_xy_correction` step 与 `domain.raman.xyCorrection` 在 MVP 中不实现（见 Open issues），因此不进入这一版的 step 集与 domain block。

### Exit Criteria

- 新核心对象不依赖旧 `ExperimentSpec`。
- `ProcedureSpec` 含 typed `domain` block，可承载 Raman 参数。
- 类型足以支撑 planner / kernel / runtime。

### Suggested Codex Goal

`Implement the MVP core schemas for ExperimentIntent, ProcedureSpec, ExecutionUnit, and RunState.`

## Phase 3: Build Persistence Boundaries

### Objective

把用户意图、冻结 spec、运行快照、事件、产物引用分开持久化，避免事实混写。

### Scope

- store 层
- 路径布局
- append-only event boundary

### Checklist

- [x] 实现：
  - [x] `intent-store.ts`
  - [x] `procedure-spec-store.ts`
  - [x] `run-store.ts`
  - [x] `event-store.ts`
  - [x] `artifact-store.ts`
- [x] 分开保存：
  - [x] intents
  - [x] frozen specs
  - [x] run snapshot
  - [x] append-only events
  - [x] artifact refs
- [x] 明确 records 目录布局
- [x] 不混写 planner facts 与 runtime facts

### Exit Criteria

- 一次 run 的输入、状态、产物都可独立追踪。
- persistence boundary 清晰。

### Suggested Codex Goal

`Implement clean persistence stores for intents, frozen specs, run state, events, and artifacts.`

## Phase 4: Implement Unit Compilation

### Objective

将 `ProcedureSpec` 编译为稳定的 `ExecutionUnit[]`，形成 progress、pause、resume 的边界锚点。

### Scope

- compile pipeline
- `grid_scan` / `point_list` 展开
- unit metadata 注入

### Checklist

- [x] 实现 `kernel/compile-units.ts`
- [x] 支持：
  - [x] `point_list -> point units`
  - [x] `grid_scan -> point units`
  - [x] `focus_plane_calibration -> progressive waypoint + five anchor point units`
- [x] 每个 unit 生成：
  - [x] `unitId`
  - [x] `index`
  - [x] `unitKind`
  - [x] point metadata
  - [x] action list
  - [x] artifact scope
- [x] limits 检查具备编译入口（compile 阶段把 `limits` 带入 unit 元数据，作为 runtime 层 hard clamp 的上游；最终硬防线在 Phase 8/9 的 runtime/driver 层落地）
- [x] 编译结果保持在 semantic action 层，不落到底层 driver 命令

### Exit Criteria

- `ExecutionUnit[]` 稳定、可计数、可恢复。
- kernel 后续可直接消费编译结果。

### Suggested Codex Goal

`Compile ProcedureSpec into stable ExecutionUnit arrays for point_list and grid_scan plans.`

## Phase 5: Ship The Simulation Vertical Slice

### Objective

先在 simulation mode 跑通完整 bounded run 生命周期，验证架构主链路成立。

### Scope

- simulation runtime
- run lifecycle
- fake artifacts / fake failures

### Checklist

- [x] 实现 `runtime/simulation-runtime.ts`
- [x] 实现 `kernel/run-controller.ts`
- [x] 支持最小 lifecycle：
  - [x] start
  - [x] poll
  - [x] pause
  - [x] abort
- [x] 输出：
  - [x] run snapshot
  - [x] progress events
  - [x] fake artifacts
- [x] 模拟失败场景：
  - [x] autofocus low confidence
  - [x] spectrum timeout
  - [x] operator pause
- [x] 提供最小 tool：
  - [x] `run_procedure`（Phase 5.5 会把它收敛到 approval gate 之后）
  - [x] `poll_run`
  - [x] `summarize_run`
  - [x] `pause_run`
  - [x] `abort_run`
- [x] `poll_run` 的文本摘要直接包含 completed / total / failed / current unit / artifacts，避免 agent 只看到 `running`
- [x] `summarize_run` 基于现有 `RunState` 汇总 progress、artifact counts、pause/abort/error，不引入新的核心对象

### Exit Criteria

- simulation 能跑通一次 bounded run。
- pause / abort / poll 有真实状态变化。

### Suggested Codex Goal

`Implement the simulation runtime and bounded run lifecycle with start, poll, pause, and abort.`

## Phase 5.5: Build The Approval And Freeze Gate

### Objective

把「proposal -> approve -> freeze -> execute」这道闸建在 kernel 与 tool 之间，并在 simulation 阶段就验证。这是 supervised 模型的承重墙：未批准的 spec 不能执行，批准后 spec 冻结为唯一执行输入。

### Scope

- approval state machine
- frozen spec boundary
- propose / approve tool split

### Checklist

- [x] 把 `run_procedure` 拆为：
  - [x] `propose_run`（产出可冻结的 `ProcedureSpec` + `requiresConfirmation`）
  - [x] `approve_and_start_run`（校验批准、冻结 spec、再交给 kernel）
- [x] 实现最小 approval 状态迁移：
  - [x] `proposed -> approved(frozen) -> running`
- [x] run-controller 启动前强制校验：
  - [x] 该 spec 已被批准
  - [x] 该 spec 已冻结且未被改写
- [x] simulation 也走这道闸（不绕过）
- [x] 拒绝路径可验证：
  - [x] 未批准的 spec 直接 run 被拒
  - [x] approved 后修改 spec 被拒

### Exit Criteria

- simulation 下「未批准不能跑、批准后不可改」两条不变量可测。
- proposal 与 execution 之间有显式 gate，而非隐式直连。

### Suggested Codex Goal

`Implement the approval and freeze gate so proposed specs must be approved and frozen before the simulation runtime executes them.`

## Phase 6: Build Planner-Side Proposal Flow

### Objective

实现从用户目标到 bounded `ProcedureSpec` proposal 的 planner 侧流程。

### Scope

- intent builder
- procedure spec builder
- proposal vs execution boundary

### Checklist

- [x] 实现 `planner/intent-builder.ts`
- [x] 实现 `planner/procedure-spec-builder.ts`
- [x] 实现最小工具：
  - [x] `get_lab_capabilities`
  - [x] `get_lab_state`
  - [x] `record_experiment_intent`
  - [x] `get_procedure_spec_template`
  - [x] `validate_procedure_spec`
  - [x] `run_preflight`
- [x] `record_experiment_intent` 将结构化研究意图写入既有 intent store，供后续 `ProcedureSpec.intentId` 引用
- [x] `get_procedure_spec_template` 暴露当前 canonical `ProcedureSpec` 形状，减少 agent 临场猜 schema
- [x] 支持的 procedure：
  - [x] `raman_single_point_probe`
  - [x] `raman_parameter_search`
  - [x] `raman_grid_mapping`
  - [x] `raman_focus_plane_calibration`
- [x] proposal 输出包含：
  - [x] risks
  - [x] limits
  - [x] estimated runtime
  - [x] save path
  - [x] requires confirmation
- [x] proposal 由 `propose_run` 产出，执行须经 Phase 5.5 的 `approve_and_start_run`

### Exit Criteria

- agent 能提出 bounded run 草案。
- proposal 与 execution 明确分离（execution 走 approval + freeze gate）。

### Suggested Codex Goal

`Implement planner-side bounded run proposal flow for Raman single-point, parameter-search, and mapping procedures.`

## Phase 6.5: Add Planner-Side Experiment Procedure Templates

### Objective

为 Raman planner 增加 workspace-local 实验方案模板，让 agent 起草 `ProcedureSpec` 时可以参考同类样品、同类实验和同类 procedure 的推荐默认参数。

### Scope

- template schema
- workspace template store
- template matching planner tool
- proposal preview provenance

### Checklist

- [x] 定义 `ExperimentProcedureTemplate`
- [x] 模板位置固定为 `lab-config/templates/*.json`
- [x] 模板只保存可继承参数，不保存 `procedureSpecId` / `experimentId` / `intentId` / 历史点位坐标
- [x] 匹配优先级：
  - [x] `sampleId` 精确匹配
  - [x] `sampleClass` 匹配
  - [x] intent keyword / tag 匹配
  - [x] `procedureId` 默认模板
- [x] 模板默认值只作为推荐，不作为强制约束
- [x] template provenance 只进入 validate / preflight / propose details，不进入 `ProcedureSpec`
- [x] 匹配失败时要求 planner 回到自主规划并向用户确认关键假设

### Exit Criteria

- agent 能在规划前查找 workspace 模板。
- 匹配模板时，proposal details 能说明 `templateId`、`templateVersion`、继承字段和覆盖字段。
- 未匹配模板时，planner 有明确 fallback 提示。

### Suggested Codex Goal

`Add planner-side experiment procedure templates for Raman defaults without changing the executable ProcedureSpec schema.`

## Phase 7: Encode Explicit "Good Enough" Rules

### Objective

用显式规则判断采集条件是否足够好，避免把这一判断交给 LLM 自由发挥。

### Scope

- metrics schema
- rule engine
- decision output

### Checklist

- [x] 定义结构化 metrics 输入
- [x] 实现规则判断：
  - [x] autofocus confidence threshold
  - [x] not saturated
  - [x] SNR threshold
  - [x] target peak / baseline threshold
  - [x] repeat consistency rule
- [x] 输出 rule-based decision：
  - [x] acceptable
  - [x] continue_search_within_envelope
  - [x] stop_and_request_user_decision
- [x] 明确 search envelope：
  - [x] allowed parameters
  - [x] max attempts
  - [x] forbidden expansions
- [x] 阈值与默认值来自 config schema，而非硬编码：
  - [x] confidence / SNR / peak-baseline 阈值有 config 默认值；当前 autofocus confidence 默认阈值为 0.15
  - [x] 默认值可被实验模板覆盖（research-style：pin config、可复现）
  - [x] 默认阈值「由谁配置」按 Open issues 处理

### Exit Criteria

- 「是否适合进入 mapping」不依赖 LLM 自由判断。
- parameter search 有清晰边界。

### Suggested Codex Goal

`Implement explicit rule-based evaluation for good-enough Raman acquisition conditions.`

## Phase 8: Add The Raman Runtime Contract

### Objective

先定义 Raman runtime contract 和资源模型，再决定具体真实硬件接入细节。

### Scope

- resource model
- runtime actions
- action result schema

### Checklist

- [x] 实现 `runtime/raman/resources.ts`
- [x] 实现 `runtime/raman/actions.ts`
- [x] 定义资源：
  - [x] stage
  - [x] frame provider
  - [x] spectrometer
- [x] 定义 runtime actions：
  - [x] `stage.get_position`
  - [x] `stage.move_absolute_and_wait`
  - [x] `autofocus.run_single`
  - [x] `frame.capture_latest`
  - [x] `spectrometer.acquire_spectrum`
- [x] 统一 action result schema：
  - [x] status
  - [x] artifacts
  - [x] errorCode
  - [x] retrySafe
  - [x] needsOperator
  - [x] safeToResume

### Exit Criteria

- kernel 与 Raman 通过 contract 对接。
- 真实硬件尚未 fully wired 也不阻碍边界稳定。

### Suggested Codex Goal

`Define the Raman runtime resource and action contract for stage, frame, autofocus, and spectrum acquisition.`

## Phase 9: Deliver Real Supervised Raman Single-Point Execution

### Objective

用新架构跑通真实受监督 Raman 单点采谱 bounded run。

### Scope

- real Raman single-point wiring
- preflight minimum checks
- minimal admission
- hazard hard-limit at runtime
- risk gating

### Checklist

- [x] Connect single-point runs to the real Raman action path
- [x] Implement minimum real preflight checks
- [x] Minimum admission (only two booleans; no in-person supervision / lease arbitration in MVP):
  - [x] preflight ready
  - [x] control available
- [x] Enforce both hard hazards in runtime/driver with hard clamp + reject:
  - [x] motion / objective collision via `minObjectiveClearanceUm` and motion bounds
  - [x] laser power ceiling via `limits.maxLaserPowerPercent`
- [x] Risk classification is effective:
  - [x] `notice`
  - [x] `confirm_required`
  - [x] `forbidden`
- [x] Support the single-point flow:
  - [x] move
  - [x] autofocus
  - [x] capture frame
  - [x] acquire spectrum
- [x] Complete artifacts flow-back
- [x] Complete rule-based analysis

### Exit Criteria

- supervised single-point real Raman run 闭环可用。
- 两类硬危险在 runtime 层有硬限制（不因用户已批准 run 而放弃底层防线）。
- 不需要先完成 mapping 才能验证架构。

### Suggested Codex Goal

`Wire supervised real Raman single-point execution with minimal admission and runtime hazard hard-limits.`

## Phase 10: Deliver Bounded Parameter Search And Mapping

### Objective

将 parameter search 和 Raman mapping 都实现为独立的 supervised bounded runs。

### Scope

- bounded parameter search
- bounded mapping
- progress and failure handling

### Checklist

- [x] 实现 `raman_parameter_search`
- [x] search envelope enforced
- [x] max attempts enforced（默认值来自 config schema，可被实验模板覆盖）
- [x] `grid_scan` mapping compile 可用
- [x] mapping progress updates 可用
- [x] 连续失败处理策略明确（跳过失败点 vs 连续失败即停，默认值来自 config schema）
- [x] mapping 不会自动扩大 grid 或自动改参数

> 注：mapping `perPoint` 在 MVP 中不含 `apply_xy_correction`（见 Open issues）。

### Focus-plane Z correction increment

- [x] calibration 与 mapping 是两个独立 proposal、approval 和 frozen ProcedureSpec
- [x] 新 mapping proposal 默认要求校准 artifact；无校正 mapping 必须记录用户明确拒绝
- [x] `point_list` mapping 与 `grid_scan` mapping 使用同一套 `surfaceCorrection` 准入规则
- [x] live-supervised approval 必须包含用户确认过的 proposalId 和 specHash
- [x] 用户可指定四角；缺省为提案时当前位置中心的 1000 µm 正方形
- [x] 四角必须互异并组成四顶点凸四边形，center 为算术中心
- [x] compiler 从冻结的当前 XY 开始，按 `maxXySpanUm` 生成有限 progressive XY waypoints
- [x] calibration 禁止 `stoppingRules.maxUnits` 截断最终 anchor / model artifact
- [x] 只使用四角加中心的五个 accepted autofocus 结果拟合 `z = a*x + b*y + c`
- [x] calibration 使用以已恢复 Z 为中心的 ±100 µm coarse-to-fine autofocus
- [x] calibration simulation 与 live runtime 都发布 `raman-focus-plane` artifact
- [x] artifact 包含五点 evidence、模型、有效区域、run/spec provenance 和 SHA-256
- [x] mapping spec 冻结 calibration run ID、artifact ID、checksum、系数和有效区域
- [x] mapping 引用的 calibration run 必须 completed，且 artifact 同时存在于 artifact index 和 completed RunState
- [x] mapping compiler 拒绝有效凸区域外点，并为每点计算 Predicted Focus Z
- [x] mapping runtime 每个 unit 验证跨 run artifact 完整性
- [x] mapping 先移动到 Predicted Focus Z，再执行固定 ±40 µm local correction
- [x] corrected mapping compiler 强制 `move_to_point -> autofocus -> acquire_spectrum` 的唯一动作顺序
- [x] compiler/preflight 在审批前检查初始 calibration 窗口和全部 mapping 窗口；runtime 对按已接受焦点动态恢复的每个 calibration 窗口在 motion 前执行 hard-limit 检查

### Exit Criteria

- parameter search 与 mapping 都是独立 bounded run。
- 产品主案例可完整演示。

### Suggested Codex Goal

`Implement bounded Raman parameter search and bounded Raman mapping runs.`

## Phase 10.5: Add Operator Hardware Surface For Lab Use

### Objective

补齐实验现场必须使用、但不属于完整 Raman `ProcedureSpec` run 的维护入口，避免 agent 为了读状态或移动 stage 而退回 legacy bridge，或把简单操作伪装成采谱 run。

### Scope

- read-only hardware status
- read-only stage position
- active frame capture
- confirmed operator autofocus
- confirmed low-power smoke spectrum
- confirmed stage-only relative motion
- runtime config example

### Checklist

- [x] 新 runtime contract 支持 `stage.get_position`
- [x] Python runtime adapter 支持只读 stage position
- [x] 新增 operator-facing tools：
  - [x] `raman_get_hardware_status`
  - [x] `raman_get_stage_position`
  - [x] `raman_capture_frame`
  - [x] `raman_run_autofocus`
  - [x] `raman_acquire_smoke_spectrum`
  - [x] `raman_stage_move_relative`
- [x] active frame capture 不要求构造 Raman `ProcedureSpec`
- [x] operator autofocus 需要显式确认并受 Z range / minObjectiveClearanceUm 约束
- [x] smoke spectrum 需要显式确认并受低功率 debug 上限约束
- [x] stage-only relative move 不要求 frame provider / spectrometer 资源
- [x] stage-only relative move 通过 runtime stage resource limits 做边界拒绝
- [x] stage-only relative move 在未显式确认时只返回 proposal，不执行 motion
- [x] 大距离 stage-only move 由 agent 编排多次 bounded relative move、出错后重读位置并询问是否继续；不新增 `MotionPlan` 对象，也不把维护移动伪装成 `ProcedureSpec`
- [x] 提供可提交的实验室默认配置 `lab-config/raman-runtime.lab.json`
- [x] 支持 git-ignored 本地覆盖 `lab-config/raman-runtime.local.json`
- [x] runtime 配置加载优先级固定为 `local > lab > none`
- [x] `get_lab_state` 暴露 runtime config source 和配置资源摘要
- [x] live runtime Python import root 固化到工作区 `lab-config/drivers/raman-python`
- [x] `docs/Raman` 降级为 reference/prototype，不再进入 live runtime import path
- [x] vendor wheel 固化到 `lab-config/drivers/raman-python/vendor`，live driver 不再从 `assets/manuals` 查找 SDK

### Exit Criteria

- 用户询问连接状态或当前位置时，agent 直接走 read-only operator tool。
- 用户要求小幅 stage nudge 时，agent 不再构造 `raman_single_point_probe`。
- legacy extension 已删除，不再是 MVP 现场操作路径。
- LabAgent 初始化时可把稳定实验室设备资源加载进上下文，本地临时改动不会污染 lab default。

### Suggested Codex Goal

`Add operator-facing Raman hardware status, position read, and confirmed stage relative move tools to the MVP rebuild.`

## Open Issues

以下问题在本计划中已显式记录，留待后续冻结，但不阻塞已排期的 Phase：

1. **三级风险模型已锚定**：`notice` / `confirm_required` / `forbidden` 已在 `core-ideas.md` Safety 节追认为 MVP（简单三级分类）。更复杂的风险分级、多角色审批、跨 run 白名单仍属目标态。本计划与 `raman-hardware-adapter-contract.md`、`core-ideas.md` 口径一致。
2. **XY correction 在 MVP 中不实现**：`apply_xy_correction` step、`domain.raman.xyCorrection`、calibration 工具链均不进第一版；`raman-hardware-adapter-contract.md` 已同步降级为 reference-only。后续若 mapping 累积误差需要补偿，再作为独立增量接入。
3. **`product_usage_example.md` 末尾四个默认值**：合适条件阈值由谁配置、连续低置信 autofocus 行为、parameter search 默认 max attempts、mapping 失败点跳过 vs 即停，均转为 Phase 7/10 的 config schema 默认值，写在代码、可被实验模板覆盖，不在 `core-ideas.md` 冻结。
4. **`RunPolicy` / lease / 监督人在场 / 多角色审批**：按 `core-ideas.md` 归为目标态，MVP 不实现；admission 仅保留「preflight ready + 控制权可用」两项布尔（Phase 9）。

## Notes On Execution Style

为避免 rebuild 重新滑回旧系统的复杂性，执行时建议保持以下习惯：

1. 先验证 simulation vertical slice，再接真实硬件。
2. 先验证 single-point，再做 parameter search 和 mapping。
3. 任何“顺手抽象”都要问一句：它是否直接服务当前阶段的主链路？
4. 如果实现与设计冲突，优先回到 `docs/design-ideas/` 澄清，而不是让代码暗中替代设计。
