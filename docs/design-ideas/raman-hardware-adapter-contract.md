# Raman 硬件适配契约

本文只定义 Raman 如何从实验室资源接入 runtime，并形成 planner/operator tool surface。kernel 的编译、状态机和恢复语义见 `kernel-execution-model.md`。

## 1. 适配目标

Raman 是第一块真实硬件样板，不是架构特例。接入链路固定为：

```text
workspace config
-> typed resources
-> Python device drivers
-> bounded runtime actions
-> planner / operator tools
```

三个硬约束：

1. Python 脚本和底层协议不直接暴露给 agent。
2. 多点 workflow 归 kernel，不藏在 Python loop 或 daemon 中。
3. tool 暴露实验/维护能力，不镜像 driver API。

## 2. Source 与配置

产品源位于：

```text
src/drivers/raman-python/
```

部署后的 workspace driver 位于：

```text
lab-config/drivers/raman-python/
```

live runtime 只从 workspace driver 目录导入。`docs/Raman` 和 `assets/manuals` 只作历史参考，不影响运行时行为。

配置分两层：

```text
lab-config/raman-runtime.lab.json
+ lab-config/raman-runtime.local.json override
```

- lab 文件保存可提交的稳定实验室配置。
- local 文件保存机器临时端口、路径、Python executable 或 enablement 覆盖，并被 Git 忽略。
- local 的 `"enabled": false` 可显式关闭当前机器的 live runtime。
- 无有效 enabled config 时只保留 simulation。

配置包含 stage、frame provider、spectrometer、preflight、spectrum evaluation 和 daemon idle timeout。planner 只引用 resource ID，不写端口、bridge path 或 driver config。

## 3. Resource model

当前资源：

| resource | 关键配置 | 当前作用 |
| --- | --- | --- |
| `stage` | port/channels/baudrate、XYZ limits | 位置读取与绝对运动 |
| `frame_provider` | LabSpec bridge dir、格式、最小采集间隔 | frame capture 与 autofocus |
| `spectrometer` | bridge request/result、允许功率档位 | spectrum acquisition |

resource 的 `leasePolicy` 当前是配置事实，不代表已经实现多 agent lease 仲裁。

## 4. Persistent Python daemon

`createRamanPythonRuntime` 惰性启动 `raman_runtime_daemon.py`，所有 live run 和 operator actions 共用同一 daemon。

当前保证：

- 请求在 TypeScript 侧串行排队，硬件 session 不并发访问。
- stage/frame session 跨 actions 复用，避免每点重新连接。
- 单 action timeout 会 kill/reset daemon；下一次 action 重新启动。
- 空闲达到 `daemon.idleShutdownMs` 后干净退出并释放端口。
- transport failure 被归一化为结构化错误，不把 traceback 当控制信号。

串行队列是 transport correctness，不是 policy lease。

## 5. Runtime action contract

当前 action：

```text
stage.get_position
stage.move_absolute_and_wait
frame.capture_latest
autofocus.run_single
spectrometer.acquire_spectrum
```

每个 `ActionResult` 都返回：

- `status: success | failed | paused`
- summary 与 optional payload
- artifacts
- `errorCode?`
- `retrySafe`
- `needsOperator`
- `safeToResume`

driver/daemon 不拥有 experiment workflow state，也不决定是否提出下一次 run。

### 5.1 Autofocus strategies

同一个 `autofocus.run_single` 支持：

| strategy | 使用场景 | Z 来源 |
| --- | --- | --- |
| `fixed_absolute` | 单点与 operator autofocus | spec/tool 给出的绝对范围 |
| `calibration_coarse_to_fine` | 硬件焦平面校准 | 当前 unit 恢复出的 accepted focus seed |
| `mapping_local_correction` | default mapping autofocus | runtime centers the local range on the most recent successful focus Z, falling back to the point Z on the first point |

TypeScript runtime 解析 strategy 和窗口；Python daemon 只执行单次有界 autofocus，不保存 previous focus 或焦平面模型。

For mapping, `mapping_local_correction` is the default unless `autofocus.params.strategy` explicitly requests `fixed_absolute`. `plan.z` is only the point-placement target. The current autofocus center is runtime state, surfaced as `lastAcceptedFocusZUm` so planners do not confuse predicted point Z with the autofocus center. When focus-plane correction is attached, the local half-range is frozen as `surfaceCorrection.localAutofocusHalfRangeUm`. When `surfaceCorrection = disabled/user_declined`, the local half-range is frozen as `domain.raman.autofocus.params.localAutofocusHalfRangeUm`; if that is omitted, the runtime falls back to the approved fixed autofocus range when present, otherwise `DEFAULT_MAPPING_LOCAL_AUTOFOCUS_HALF_RANGE_UM`. `fineHalfRangeUm` belongs to calibration coarse-to-fine autofocus and must not define the mapping local correction window.

默认 `domain.raman.environment.vacuumState = vacuum` 使用 `metricName = labspec_center_spot_focus` 与 Z motion profile `("mm", "step", 50, 1000)`。`labspec_center_spot_focus` 使用 Tenengrad 平方根除以 ROI 平均亮度，再乘以连续的光轴中心填充支持度。亮度归一化梯度负责保留接近焦点时的上升/下降曲线；光轴中心填充支持度抑制离焦空心环，即使环纹本身具有很强边缘也不会被误判为最佳焦点。对于清晰、紧凑、接近中心但中心小圆存在暗纹结构的环纹焦点，metric 会给光轴支持度一个有限下限，避免把真实清晰焦点压低到相邻离焦帧之下。对已经得到高基础分且中心填充充分的帧，metric 还会用竖向拖尾 guard 惩罚亮斑质心偏移和纵向拉伸，避免把中心仍然发亮但形态拖尾的帧当成高质量焦点。metric 名称和调用契约保持不变；最终验证分数严格小于 `0.75` 时触发低分二次聚焦，等于 `0.75` 时不触发。旧的同心亮斑 / 环纹启发式保留为显式兼容名称 `labspec_center_spot_focus_old`，不再作为默认 metric。

未抽真空 / 无光窗实验显式设置 `domain.raman.environment.vacuumState = not_vacuum`；runtime 从该冻结字段派生 `metricName = labspec_no_window_spot_focus` 与 Z motion profile `("mm", "step", 30, 1000)`。该 metric profile 复用 `labspec_spot_compactness`：先按 ROI 的稳健百分位归一化并扣除中位背景，再以信号三次方作为权重，按亮斑核心能量占比与加权 RMS 半径的比值评分；无光窗标定序列中紧凑亮斑因此得到最高分，而宽散光斑回落。`vacuumState` 是被冻结并随 proposal 审查的实验条件选择；runtime 只按该字段解析，不根据硬件现场状态自行猜测。`autofocus.params.metricName` 仍可作为特殊实验的显式覆盖，但普通真空/未抽真空切换应优先使用环境字段。

MC.Newton XYZ driver 在 Z settle 等待中执行同一套自适应 motion rescue，但梯度从当前环境 profile 派生。默认真空梯度为 `50 V / 1000 Hz -> 50 V / 800 Hz -> 50 V / 600 Hz -> 50 V / 500 Hz`；默认未抽真空梯度为 `30 V / 1000 Hz -> 35 V / 1000 Hz -> 40 V / 800 Hz -> 45 V / 600 Hz -> 50 V / 500 Hz`。单次 Z move 最多 rescue 两次：当 `move_close_target` 返回空响应 `TargetSetError`、remaining pulses 已清零但残差仍大于 `max(2 * tolerance, 8 um)`、或残差持续无改善时，driver 用下一档参数重发同一目标。SDK 读数/通讯错误、负 Z、疑似归零或跳变读数不触发 rescue，继续按 stage error/timeout 暴露。若同一 daemon session 内最近 10 次 Z settle 中有 2 次 rescue 后成功，后续 Z move 的全局基准档位上调一级；运行中不自动降档，电压上限固定为 50 V，频率只下调不超过梯度下限。`stageMoveCommands` 记录每次命令使用的 adaptive level/profile，`stageSettleDiagnostics.zAdaptiveMotion` 记录 rescue 触发原因、档位变化和全局升档。

历史 live mapping 记录显示，成功 autofocus 的保存帧最大间隔约 21.3 秒，保存帧等待超时保持 `frameTimeoutMs = 30000`；失败样本集中在 `stageTimeoutMs = 10000`，Z 轴仍在进入 5 µm 容差或稳定性判定阶段，因此 live runtime 会把 autofocus 单次 stage settle timeout 夹紧到至少 `60000`，最高仍不超过 `120000`。完整 autofocus action timeout 使用 `300000`，覆盖最近 18 帧 autofocus 流程约 180 秒的历史上界并保留恢复余量。

## 6. Tool surface

工具注册以 `src/extensions/experiment-research/index.ts` 为事实基线。

### 6.1 Planning 与 run management

```text
get_lab_capabilities
get_lab_state
record_experiment_intent
find_experiment_procedure_template
get_procedure_spec_template
validate_procedure_spec
run_preflight
calculate_focus_plane_from_xyz_points
register_operator_focus_plane_calibration
propose_run
revise_proposal
approve_and_start_run
poll_run
summarize_run
pause_run
resume_run
abort_run
```

`run_procedure` 仍注册为 deprecated blocked entrypoint，只返回 `approval_required`；正式执行必须走 proposal/approval。

### 6.2 Operator maintenance

```text
raman_get_hardware_status
raman_get_stage_position
raman_capture_frame
raman_capture_frame_no_laser
raman_run_autofocus
raman_acquire_smoke_spectrum
raman_stage_move_absolute
raman_stage_move_relative
```

边界：

- status/position 是 read-only。
- frame capture 是现场观察，不构造实验 spec；`laserOff` 由专用工具显式表达。
- operator autofocus 会产生 Z motion，必须确认并受 objective clearance / Z limits 约束。
- smoke spectrum 是低功率 debug action，不替代正式采集 run。
- absolute move 保留未指定轴、校验三轴 limits、读回 residual，并在有限次数内闭环。
- relative move 只用于真实单轴 nudge；绝对目标不能拆成多个 relative calls。

operator tool 适合维护、观察和诊断。正式单点、参数搜索、calibration 和 mapping 仍走 bounded `ProcedureSpec`。

## 7. Raman `ProcedureSpec`

Raman 参数只进入 typed `domain.raman`：

- `environment?`：`vacuumState = vacuum | not_vacuum`，用于派生默认 autofocus metric 与 Z motion profile；未声明时按 `vacuum` 兼容旧 spec
- `autofocus`：enabled、ROI、params、strategy
- `acquisition`：integration time、laser power、accumulations、format、timeout
- `parameterSearch?`：max attempts 与批准 envelope

资源配置不进入 domain；请求 laser power 必须同时满足 spectrometer 允许档位与 `limits.maxLaserPowerPercent`。

当前 procedure：

| procedure | plan |
| --- | --- |
| `raman_single_point_probe` | `current_position` 或单点 `point_list` |
| `raman_parameter_search` | 同一点重复 `maxAttempts` 次的 `point_list` |
| `raman_grid_mapping` | `grid_scan` 或 `point_list` |
| `raman_focus_plane_calibration` | `focus_plane_calibration` |

## 8. Focus-plane correction

当前有三条明确路径。

### 8.1 一次性人工三点计算

当用户已经有三个非共线 focused XYZ：

```text
calculate_focus_plane_from_xyz_points
-> coefficients + triangular validRegion
-> surfaceCorrection.source = manual_xyz_points
```

这是纯计算：无 hardware motion、approval、RunState 或 artifact provenance。适合一次 proposal 使用。

### 8.2 持久化 operator 三点

`register_operator_focus_plane_calibration` 在显式确认后：

- 验证三个唯一、非共线 XYZ。
- 拟合模型并派生三角形 valid region。
- 写 completed `RunState`、artifact index 和 immutable `focus-plane.json`。
- 标记 `source.kind = operator_supplied_xyz`。

系统只保证数学与持久化自洽，不声称这些点由 runtime autofocus 验证。当前没有 sample placement identity；样品重新放置后停止复用由 operator 负责。

### 8.3 硬件采集校准

`raman_focus_plane_calibration` 是独立 bounded run：

- 默认四角是 proposal-time 当前 XY 周围的正方形；用户可覆盖。
- 四角必须形成凸四边形，中心是算术平均。
- compiler 插入 progressive XY waypoints。
- waypoint 用于导航/恢复；只有中心和四角五个 anchors 进入拟合。
- runtime 从已持久化 autofocus artifact 恢复下一 unit 的 Z。
- 最终 anchor 发布 immutable `raman-focus-plane` artifact。

calibration 完成不批准 mapping；mapping 必须形成新的 proposal。

### 8.4 Corrected mapping

mapping spec 冻结：

- artifact identity 与 checksum，或 manual anchors
- coefficients
- valid region
- local autofocus range as `surfaceCorrection.localAutofocusHalfRangeUm` for corrected mapping, or `domain.raman.autofocus.params.localAutofocusHalfRangeUm` when focus-plane correction is disabled (default 40 um, explicitly overridable per mapping proposal)

compiler 拒绝区域外点，计算 predicted Z，并要求 `move_to_point -> autofocus -> acquire_spectrum` 顺序。preflight/live runtime 对 artifact 路径重新校验 identity、checksum、coefficients 与 region；不匹配时 fail closed，不静默退回 fixed Z。

用户明确拒绝 correction 时，`surfaceCorrection = disabled/user_declined`，所有点必须冻结 fixed Z。

## 9. Preflight 与 hard limits

preflight 检查：

- live runtime 是否注册
- stage/frame/spectrometer 资源是否满足 spec roles
- Python root / bridge / stage connection 的配置要求
- current stage 与 approved autofocus/anchor envelope
- focus-plane artifact provenance
- `preflightReady` 与 `controlAvailable`

runtime 在每次 effectful action 前再次执行：

- resource resolution
- XYZ range
- objective clearance
- laser power ceiling/allowed values
- focus-plane reference and autofocus window checks

approval 不能绕过这些 hard limits。

## 10. Artifact 与错误

当前核心 artifacts：

- frame
- autofocus evidence/curves
- spectrum 与 plot
- `raman-focus-plane`

所有 payload 通过 `ArtifactRef` 登记；上层不能靠 message 猜路径。

Raman/transport error 必须有稳定 `errorCode` 和 retry/operator/resume flags。当前代码覆盖 stage、frame、autofocus、spectrum、bridge、focus-plane 与 Python daemon 类错误；完整 code 列表以 runtime source 为准，避免在设计文档复制后漂移。

Spectrum file bridge uses two bounded completion signals. A matching worker result
is authoritative. At the unchanged acquisition deadline, a non-empty,
size-stable file at the unique approved output path is accepted as a completed
acquisition and recorded as `completion_source =
saved_output_reconciliation`. An output file that existed before the request
fails closed. This prevents delayed control-plane status from discarding an
already-saved spectrum without extending the approved acquisition timeout.

## 11. 非目标

当前不实现：

- XY image correction
- 裸 serial/SDK/file-bridge planner tools
- Python 持有多点 workflow
- 多 agent lease arbitration
- 自动判断 sample placement 是否失效
- operator maintenance action 绕过确认或 hard limits
