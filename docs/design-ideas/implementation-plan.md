# Experiment Research 实现状态与下一步

本文只记录当前实现基线、尚未完成的工作与验收条件。已经完成的历史 phase 不再逐项保留；精确行为由专题设计和代码定义。

## 1. 实现基线

唯一 MVP extension：

```text
src/extensions/experiment-research/
```

默认验证入口：

```bash
./test.sh
npm run check
```

`./test.sh` 使用 fake runtime/daemon，不连接真实 Raman 硬件或外部 provider。真实硬件验证必须使用显式 hardware-validation command，并只在目标实验机运行。

## 2. 已实现能力

### 2.1 Planner 与对象

- `ExperimentIntent`、`ProcedureSpec`、`ExecutionUnit`、`RunState` typed schemas
- intent/spec/proposal/run/event/artifact 分离持久化
- workspace-local `ExperimentProcedureTemplate` 匹配与 provenance
- canonical spec template、validation、preflight 与 proposal preview
- `notice / confirm_required / forbidden` 风险分类
- 显式 Raman “good enough” evaluation rules

### 2.2 Kernel

- `current_position`、`point_list`、line generator、`grid_scan`、`focus_plane_calibration` 编译
- simulation 与 `live-supervised` 共用 approval/freeze gate
- proposal ID/hash approval 与 `revise_proposal`
- linear、parameter-search、mapping execution strategies
- point attempt、immediate/final retry、连续失败限制
- async poll/summarize、pause、abort、resume
- inter-point delay、heartbeat、events 与 artifacts
- paused/failed/completed/aborted terminal notification

### 2.3 Raman live runtime

- stage、frame provider、spectrometer typed resources
- persistent serialized Python daemon
- stage position/absolute motion、frame capture、autofocus、spectrum actions
- workspace lab config + local override
- runtime motion/objective/power hard limits
- fixed、calibration coarse-to-fine、mapping local autofocus strategies

### 2.4 Bounded Raman procedures

- single-point acquisition
- bounded parameter search
- grid/point-list mapping
- hardware focus-plane calibration
- manual three-point pure calculation
- operator-supplied three-point artifact registration
- corrected mapping artifact provenance and valid-region enforcement

### 2.5 Operator surface

- hardware status and stage position
- frame capture with normal/no-laser variants
- confirmed autofocus and low-power smoke spectrum
- confirmed closed-loop absolute move
- confirmed single-axis relative nudge

operator tools 不替代正式 experiment run，也不绕过 runtime limits。

## 3. 当前最高优先级：真实故障快速收敛

现场运行仍会把部分持续硬件故障当作普通点失败反复执行，也会把可恢复的瞬时连接问题交给用户重发。

### 3.1 同因故障熔断

待实现：

- 从 runtime error 形成稳定 cause key，首选 `errorCode + payload.axis`。
- 连续同 key 默认两次后 pause，reason 为 `repeated_same_cause_failure`。
- pause summary 带 cause、次数和关键实测值。
- operator 修复硬件后由现有 `resume_run` 继续。
- `maxConsecutiveFailures >= maxUnits` 时 validation 给出规则不可能触发的 notice。

验收：

- 同一机械故障不再逐点消耗完整 timeout。
- 已完成 mapping points 不因故障处置而丢失。

### 3.2 瞬时连接重试

待实现：

- 只对明确 `retrySafe` 的连接/daemon startup 类错误做有限退避重试。
- 每次重试前 reset daemon。
- retry count 与最终错误进入 agent 可见 summary。
- stage settle timeout 不自动重试，由同因故障策略处理。

验收：

- 可恢复连接抖动不要求用户重发同一句话。
- 真实机械 timeout 不被自动重复燃烧时间。

### 3.3 参数不得静默失效

待实现：

- 每个 autofocus strategy 声明实际消费的 params。
- spec 出现 strategy 不消费的字段时，validation 返回 forbidden risk。
- hardware calibration coarse range 从硬编码提升为 plan/domain 可表达参数，默认行为保持兼容。

验收：

- spec 参数要么被执行，要么在批准前被拒绝。

### 3.4 Calibration anchor gate

当前 `allowedDriftUm` 固定为 5，且 preflight 可能检查 run 首 unit 即将覆盖的 XY 状态。

候选设计：

- 首 unit 明确移动到 frozen start point 时跳过 XY anchor drift check。
- Z envelope 与 objective-clearance 检查继续保留。
- 其他场景从 stage settle/noise 配置推导 drift allowance。

该项改变 fail-closed admission 语义，实施前仍需用户单独确认最终规则。

### 3.5 重复绝对目标的确认语义

待实现：

- 同一 absolute target 因 settle timeout 未到达时，重发该目标不要求新的风险确认。
- target 改变时必须重新确认。
- 不引入跨调用的会话级运动白名单。

## 4. UI 工作

`labagents-ui.md` 仍是 planning：

- 尚无 `InstrumentSnapshot`
- 尚无 instrument status widget
- 尚无定时只读刷新

UI 实现不阻塞 kernel/Raman 主链路，但会改善 operator 态势感知。它不得引入 effectful 快捷操作或并发硬件读取。

## 5. 明确非目标

当前不排入 MVP：

- XY image correction
- 通用多仪器 orchestration platform
- full watchdog/policy engine
- 多 agent lease arbitration
- 多角色审批与监督者物理在场证明
- autonomous multi-run execution
- canonical artifact representation lifecycle

新需求出现时应先更新专题设计，不在现有 schema 中预埋未使用字段。

## 6. 实施纪律

每个增量必须：

1. 先确认它解决真实主链路问题，而不是增加备用抽象。
2. 从现有函数与 schema 组合，只有必要时才新增概念。
3. 同步更新对应专题文档，避免实施计划复制契约。
4. 新增/修改测试时先运行具体 extension test，再运行 `./test.sh`。
5. 代码改动后运行 `npm run check` 并清除全部 error/warning/info。
6. hardware validation 与默认测试严格分离。
