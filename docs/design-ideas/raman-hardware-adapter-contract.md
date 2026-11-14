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
| `mapping_local_correction` | default mapping autofocus | 最近一次验收成功的 focus Z；首点在禁用焦平面时使用首次移动前实测 Z，启用焦平面时使用预测点 Z |

TypeScript runtime 解析 strategy 和窗口；Python daemon 只执行单次有界 autofocus，不保存 previous focus 或焦平面模型。

For mapping, `mapping_local_correction` is the default unless `autofocus.params.strategy` explicitly requests `fixed_absolute`. With a focus plane attached, planned Z remains the predicted point-placement target. With `surfaceCorrection = disabled/user_declined`, both placement Z and the local autofocus center follow the initial measured Z / last accepted focus policy in 5.5. The accepted focus is runtime state, surfaced as `lastAcceptedFocusZUm`. When focus-plane correction is attached, the local half-range is frozen as `surfaceCorrection.localAutofocusHalfRangeUm`. When correction is disabled, the local half-range is frozen as `domain.raman.autofocus.params.localAutofocusHalfRangeUm`; if that is omitted, the runtime falls back to the approved fixed autofocus range when present, otherwise `DEFAULT_MAPPING_LOCAL_AUTOFOCUS_HALF_RANGE_UM`. `fineHalfRangeUm` belongs to calibration coarse-to-fine autofocus and must not define the mapping local correction window.

默认 `domain.raman.environment.vacuumState = vacuum` 使用 `metricName = labspec_center_spot_focus` 与 Z motion profile `("mm", "step", 50, 1000)`。`labspec_center_spot_focus` 使用 Tenengrad 平方根除以 ROI 平均亮度，再乘以连续的光轴中心填充支持度。亮度归一化梯度负责保留接近焦点时的上升/下降曲线；光轴中心填充支持度抑制离焦空心环，即使环纹本身具有很强边缘也不会被误判为最佳焦点。对于清晰、紧凑、接近中心但中心小圆存在暗纹结构的环纹焦点，metric 会给光轴支持度一个有限下限，避免把真实清晰焦点压低到相邻离焦帧之下。对已经得到高基础分且中心填充充分的帧，metric 还会用竖向拖尾 guard 惩罚亮斑质心偏移和纵向拉伸，避免把中心仍然发亮但形态拖尾的帧当成高质量焦点。metric 名称和调用契约保持不变；固定范围聚焦的细化与验收门槛见 5.4。旧的同心亮斑 / 环纹启发式保留为显式兼容名称 `labspec_center_spot_focus_old`，不再作为默认 metric。

未抽真空 / 无光窗实验显式设置 `domain.raman.environment.vacuumState = not_vacuum`；runtime 从该冻结字段派生 `metricName = labspec_no_window_spot_focus` 与 Z motion profile `("mm", "step", 30, 1000)`。该 metric profile 复用 `labspec_spot_compactness`：先按 ROI 的稳健百分位归一化并扣除中位背景，再以信号三次方作为权重，按亮斑核心能量占比与加权 RMS 半径的比值评分；无光窗标定序列中紧凑亮斑因此得到最高分，而宽散光斑回落。`vacuumState` 是被冻结并随 proposal 审查的实验条件选择；runtime 只按该字段解析，不根据硬件现场状态自行猜测。`autofocus.params.metricName` 仍可作为特殊实验的显式覆盖，但普通真空/未抽真空切换应优先使用环境字段。

MC.Newton XYZ driver 在 Z settle 等待中执行同一套自适应 motion rescue，但梯度从当前环境 profile 派生。默认真空梯度为 `50 V / 1000 Hz -> 50 V / 800 Hz -> 50 V / 600 Hz -> 50 V / 500 Hz`；默认未抽真空梯度为 `30 V / 1000 Hz -> 35 V / 1000 Hz -> 40 V / 800 Hz -> 45 V / 600 Hz -> 50 V / 500 Hz`。Z 到位要求残差 `<= tolerance`（默认 5 µm），且脉冲已结束、相邻位置变化小于稳定性容差；补救只适用于残差 `> tolerance`，不再存在 5–10 µm 的空档。每次尝试至少观察 1500 ms，并连续 4 次未比此前最佳残差改善超过 `max(stabilityToleranceUm, 0.001)`，才允许升档重发同一目标；空响应 `TargetSetError` 和零脉冲都不能绕过这个持续性条件。零脉冲原因还要求连续两次位置稳定。每次补救后重新计时，单次 Z move 最多补救两次，不延长原始 timeout，也不在到达期限后重发。SDK 读数/通讯错误、非有限读数、负 Z、疑似归零或相邻跳变超过 2000 µm 不触发补救；这些检查并不证明所有位置反馈都可信。

小残差补救只影响本次动作。只有首次补救前残差大于 `max(2 * tolerance, 8 µm)` 且最终到位的动作，才计入全局升档；同一 daemon session 内最近 10 次成功 Z settle 中有 2 次满足该条件，后续动作的全局基准档位上调一级。运行中不自动降档，电压上限固定为 50 V，频率按既定梯度调整。`stageMoveCommands` 记录每次命令使用的 adaptive level/profile；`stageSettleDiagnostics.zAdaptiveMotion` 记录补救原因、档位变化、`promotionRule.firstRescueResidualMustExceedUm`、`promotionEligible` 和全局升档。

历史 live mapping 记录显示，成功 autofocus 的保存帧最大间隔约 21.3 秒，保存帧等待超时保持 `frameTimeoutMs = 30000`；失败样本集中在 `stageTimeoutMs = 10000`，Z 轴仍在进入 5 µm 容差或稳定性判定阶段，因此 live runtime 会把 autofocus 单次 stage settle timeout 夹紧到至少 `60000`，最高仍不超过 `120000`。完整 autofocus action timeout 使用 `300000`，覆盖最近 18 帧 autofocus 流程约 180 秒的历史上界并保留恢复余量。

### 5.2 聚焦位置读取与图像绑定

移动到 mapping 点时仍分别等待 X、Y、Z 到位；位置查询 action 仍读取完整 XYZ。固定范围聚焦期间，Z adapter 直接调用 `get_axis_position_um("z")`，不再为每次 Z 读数切换 X/Y 通道。聚焦 action 内不发出 X/Y 移动；这保留了移动阶段的横向到位检查，但不提供外力或机械耦合导致的连续 XY 漂移监测。

MC.Newton 的位置查询默认采集 6 次、丢弃初始 1 次，然后检查最新 3 次的极差是否不超过现有稳定性容差（默认 0.2 µm）。不返回较早的稳定数值对，也不把不稳定序列的中位数当成已稳定的位置；必要时继续采样，默认位置读取期限为 3000 ms，超时明确失败。请求采样数小于 2 时提升到 2。运动等待可以观察尚未稳定的反馈以判断收敛，但只有最新原始窗口稳定且满足原有到位、脉冲结束判据时才完成；不稳定反馈不触发自适应重发。

固定范围 scanner 在预热与计分帧组成的采集批次前后分别读取稳定 Z。两次读数都必须是有限值且位于目标容差内（默认 5 µm），前后变化不得超过稳定性容差（默认 0.2 µm）。校验失败的样本不计算分数、不进入选峰，已采集帧保留。最终接近和回位读数同样校验目标误差；`zBestUm` 与 `finalScore` 必须来自同一个最终验证样本。

成功与失败结果均在 `confidenceDiagnostics.positionSamples` 保留固定范围聚焦每次采样/回位的角色、目标、读数、校验状态；采样条目还包含采图前后 Z、原始读取序列及单调时钟时间戳、帧路径/序号/时间戳。最终验证和低分细化验证也在其中，不能仅凭最后一次 `stageSettleDiagnostics` 推断此前扫描帧的位置。失败样本保留错误信息；整点 retry 策略由 kernel 决定。

查看记录的位置：原始点目录的 `autofocus_result_0001.json` 下为 `confidenceDiagnostics.positionSamples[]`；workspace 的 `lab-records/runs/<runId>/<specId>/unit-XXXX-autofocus.json` 下为 `payload.confidenceDiagnostics.positionSamples[]`。原始 JSON 和返回 payload 均包含 `scanPoints`。每个采样条目中：

| 字段 | 含义 |
| --- | --- |
| `sampleRole` / `status` | 粗扫、拟合验证、细化、最终验证、接近或回位，以及接受/拒绝状态 |
| `targetZUm` / `allowedZRangeUm` | 本次目标与原始扫描上下界，单位 µm |
| `readbackRangeToleranceUm` | 读回位置的上下边界各自允许的误差，固定为 5 µm；目标位置仍使用原始范围 |
| `beforeCapture.zUm` / `afterCapture.zUm` | 整批采图前后经过稳定性检查的位置，非每帧曝光瞬间的位置 |
| `beforeCapture.rawRead.readsUm` / `readTimestampsMonotonic` | 逐次 SDK 位置读数（由 mm 转为 µm）及其一一对应的读取时间；`afterCapture.rawRead` 同理 |
| `score` | 本采样计分帧分数的中位数；只有 1 帧时就是该帧分数 |
| `frames[].path` / `seq` / `timestamp` / `score` | 同次采样内每张图的路径、序号、时间和分数 |
| `frames[].role` / `usedForPointScore` | 区分预热帧与实际计分帧；预热帧不计分 |

位置读取时间与帧时间均使用单调时钟秒数，不能直接当成 UTC 日期。LabSpec 文件桥把文件修改时间换算到单调时钟，尚无相机硬件曝光时间。成功样本沿用只保留代表帧的策略，预热和其他计分帧的元数据仍可存在而文件已删除；位置校验拒绝后不删除已采集帧。接近/回位条目有 `afterMove`，没有图像或分数。历史实验没有保存的新字段不能事后补全。

### 5.3 聚焦扫描范围

单次 action 的原始范围为 `[min(zStartUm, zEndUm), max(zStartUm, zEndUm)]`，包含两端点。daemon 在连接 stage/frame provider 前检查端点有限、不相同，并在配置了资源 Z limits 时检查整个范围属于资源 limits。

每次扫描、拟合验证、低分细化、最终验证、接近和回位的目标均在下发前检查原始范围；固定范围 Z adapter 同时检查绝对与相对移动的最终目标。考虑位移台位置反馈误差，采图前后、接近和回位后的读回位置允许落在 `[原始下限 − 5 µm, 原始上限 + 5 µm]`，包含容差端点。该读数边界容差独立于目标到位容差；固定范围采样仍校验读数与目标的误差及采图前后稳定性。超出 5 µm 边界容差或非有限的读数不参与打分或选峰。原始扫描网格、移动目标和资源硬限位不因此扩大。该检查不代替硬件在运动途中的限位。

低分细化保持现有 5 点策略，窗口为中心 ±8 µm 与原始范围的交集，再在交集内等距生成 5 点。中心读数允许同样的 5 µm 边界误差；选中峰值读数若位于边界容差内但超出原始范围，回位与最终复测目标取最近的原始端点，记录保留实际读数。接近目标限制到原始上界，最终目标已在上界时跳过额外接近。calibration scanner 同样对位置读数使用 5 µm 边界容差。超过容差的越界返回 `autofocus_out_of_range`，`retrySafe = false`、`needsOperator = true`、`safeToResume = false`；这些标记不代表 kernel 已实现自动暂停或整点重扫策略。

### 5.4 固定范围聚焦质量与整点重测

daemon 对固定范围和 mapping local correction 强制执行 10 点全范围扫描。已有拟合峰验证仍保留，只接受实测优于扫描最高分的拟合候选。回到候选位置复测后，必须同时满足：分数至少 0.75、达到本轮最高实测分数的 70%、现有置信度至少 0.2；非有限分数不能通过。等于门槛可以通过。

任一门槛未通过，围绕本轮最高实测位置执行一次 5 点细化，窗口最多 ±8 µm 且限制在原始扫描范围内。最终候选从粗扫、拟合验证、首次复测和细化的全部已测位置中取最高分，不能仅因细化点高于一次退化后的复测就替代更高的旧峰。再次回位复测后执行同样三项门槛，仍不通过则返回 `autofocus_low_confidence`、`recommendation = retry`，`retrySafe = true`、`needsOperator = false`、`safeToResume = true`，不进入采谱。`confidenceDiagnostics.qualityChecks[]` 保存每轮验收的最高实测分数/位置、最终分数/位置、比例、置信度、门槛和失败项。位置证据仍在 `positionSamples[]`。

0.75 沿用当前固定范围聚焦的既有分数尺度，不能视为所有自定义 metric 的通用标定阈值。calibration coarse-to-fine 保留原流程。本节增加的是固定范围聚焦验收，不增加 Python 内部整点 retry loop。

整点重测由 kernel 现有 mapping `retryPolicy` 执行，agent 在提案中配置策略。要求“立即重测最多一次、无结束后补测”时使用 `maxImmediateRetriesPerPoint = 1`、`maxFinalRetriesPerPoint = 0`；显式 0 次或其他已批准策略不被 driver 覆盖。低质量失败不更新 accepted focus Z。禁用焦平面的 local mapping 按 5.5 持久化每点原始窗口，立即重测、结束后补测和暂停恢复都复用它；超出边界的错误不可自动重试。独立 operator autofocus 与非 mapping linear run 不会因此获得隐式整点重测。

workspace 首次聚焦记录仍为 `unit-XXXX-autofocus.json`，重测依次保存为 `unit-XXXX-autofocus-attempt-2.json` 等，artifact ID 也独立，使用独占创建避免覆盖。JSON 和 artifact metadata 的 `autofocusAttemptNumber` 表示该点第几次聚焦调用；kernel 的 `pointAttempts[].phase/attemptIndex/artifactIds` 表示 initial、immediate_retry、final_retry 的调度记录，两者通过 artifact ID 关联。不得只读第一个 JSON 就推断最终重测结果。

### 5.5 禁用焦平面的 mapping 中心继承

所有新 `raman_grid_mapping` 默认关闭焦平面校正。省略 `surfaceCorrection` 与 `disabled/default_disabled` 采用相同策略；新 proposal 在计算 `specHash` 前将省略字段写成 `{ kind: "disabled", reason: "default_disabled" }`，不要求用户先拒绝校正。用户显式拒绝时仍记录 `user_declined`。只有显式提供 `focus_plane` 时才启用校正，其模型、区域与 artifact 校验继续执行，不会因验证失败退回默认模式。

未显式选择 `fixed_absolute` 时，首个点在任何移动前读取有限 XYZ，以实测 Z 作为本次 run 的 `initialFocusZUm`。后续新点继承最近一次成功 autofocus 的 Z；如果之前尚无聚焦成功点，继续使用初始 Z。失败扫描留下的物理位置不能成为新中心。grid origin、point-list points 和 line generator 可以仅填写 XY，实际 Z 来自运行状态，不需要占位 Z。

每点首次执行时生成中心 ± 批准半宽的窗口，并在任何移动前写入 `run-state.json.mappingFocusWindows[unitId]`，包含 `centerZUm`、`zStartUm`、`zEndUm` 和 `source`（`initial_position` 或 `previous_accepted_focus`）。`focusCenterPolicy` 为 `previous_successful_then_initial_position`。XY 仍取编译后的点位，移动目标 Z 使用该点保存的中心。立即重测、结束后补测、暂停恢复均复用该点窗口，即使之后其他点已经聚焦成功也不改变原窗口。

编译阶段只能检查窗口宽度能够容纳于批准 Z 限位；preflight 使用当时实测 Z 检查首个窗口，执行时重新读取并冻结实际初始 Z。每点在移动前检查中心和整个窗口均处于 spec limits 与硬件资源 limits 的交集，不自动平移、裁剪或扩大窗口。窗口内部各采样仍执行 5.3 的逐点边界检查。初始读数失败、非有限读数、保存窗口与冻结半宽不符都拒绝执行；历史 run 缺少初始中心证据时不能在重试/恢复中以当时位置重新定中心。

该模式要求初始 Z 足够接近样品焦面。相邻点高度突变、扫描换行或跳点使新焦点超出半宽时，仍可能聚焦失败；执行 5.4 的质量验收和已批准 retry，不自动扩大范围。启用焦平面、显式 `fixed_absolute`、独立 operator autofocus 与焦平面标定保留各自策略。

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

工作区 `lab-config/templates` 中的 `ExperimentProcedureTemplate` 可复用已审查的相机 ROI。`find_experiment_procedure_template` 将模板实际内容及 `templateApplication` 放进 tool 的文本回复；canonical template 也返回完整示例内容，但不声称示例参数经过当前硬件验证。原来仅在 `details` 中保存模板、文本只说“已加载”的方式不能保证 planner 获得具体数值。

`validate_procedure_spec`、`run_preflight` 和 `propose_run` 使用同一 ROI 解析：当 `templateApplication.inheritedFields` 包含 `domain`、`domain.raman`、`domain.raman.autofocus` 或 `domain.raman.autofocus.roi`，且 `overriddenFields` 未覆盖 ROI 或其父/子路径时，程序直接读取指定模板版本的 ROI。模板必须通过 schema 校验、procedure 匹配，并与 spec 使用同一个唯一 `frame_provider` resource ID；缺失、版本不符或相机不匹配时明确失败。其他模板参数继续遵循已有 planner 行为。显式 ROI 覆盖优先，必须在 `overriddenFields` 声明并提供替换坐标。

验证、preflight 成功回复、新提案和修改后的提案均显示最终 ROI 的左上角 `x/y`、`width/height`（单位 pixel）及来源；结构化结果包含 `autofocusRoi` 与可选 `autofocusRoiSource`。继承在生成 spec hash 之前完成，实际坐标写入 proposal.spec，模板 ID/版本/相机 ID 写入 proposal 的来源信息。提案修改复用已保存坐标，模板后续变化不会改变既有提案；ROI 或相机变化会清除旧来源标记。该机制不自动采集图像或验证分辨率，复用前仍需确保模板针对当前成像设置；无模板时显示 spec 的显式坐标，不从历史目录猜测配置。

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

默认 mapping 使用 `surfaceCorrection = disabled/default_disabled`，用户明确拒绝时使用 `disabled/user_declined`。local mapping 允许只提供 XY，实际移动 Z 与聚焦中心由 5.5 的运行状态决定。显式 `fixed_absolute` 仍要求计划 Z 并使用声明的绝对聚焦范围。默认关闭不是额外确认项；整个实验仍须按原流程批准精确 proposal/hash。已有明确配置了焦平面的方案与冻结实验不被自动改写。

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
