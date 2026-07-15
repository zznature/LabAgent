# Raman 硬件与 Tool 接入方案

本文不讨论 kernel 的执行状态机。那部分已经在 `kernel-execution-model.md` 里定义。

本文只回答下面这个问题：

> 以 Raman 为例，一类真实硬件应该怎样接进系统，变成 runtime 可调用的 driver、composite action 和 tool surface？

重点是：

- 真实硬件资源如何注册
- Python 脚本如何收敛成 driver
- 哪些能力暴露成 runtime action
- 哪些能力暴露成 planner / operator tool
- 哪些底层能力必须永远不暴露给 Agent

## 1. Raman 在整个设计里的角色

Raman 不是最终架构本身，而是第一块真实硬件样板。它的价值是：

1. 有实验室里已经试过的 Python 硬件脚本
2. 同时包含多类能力：
   - stage
   - frame capture
   - autofocus
   - XY correction (future/reference only)
   - spectrum acquisition
3. 足够复杂，能逼出一套通用硬件接入边界

本文目标不是“把 Raman 做成特例系统”，而是：

> 用 Raman 逼出通用硬件接入方案中最难的那部分：真实设备、driver、runtime action、tool surface 的分层。

## 2. 第一性原理

真实硬件接入最容易犯的错误有两个：

1. 把 Python 硬件脚本直接暴露给 Agent
2. 把领域脚本直接当作最终 runtime / kernel

这两条都不成立。

正确拆分是：

- 工作区 `lab-config/drivers/raman-python`（部署自产品源码 `src/drivers/raman-python`）提供 live runtime 的真实硬件 driver
- Hardware Runtime 持有 driver session 并调度 action
- Tool surface 只暴露上层真正需要的入口

因此本文坚持三个硬约束：

1. **Raman 脚本不是 planner tool**
2. **Raman 的多点 workflow 不能直接当 kernel**
3. **tool 暴露实验能力，不暴露驱动细节**

## 3. Raman 能力来源

Raman MVP 的 live runtime 只从工作区 `lab-config/drivers/raman-python` 导入驱动。
`docs/Raman` 是 legacy/reference source：可用于迁移算法和设备知识，但不进入运行时 import path。

MVP 至少收敛这些能力：

| 能力域 | 当前性质 |
| --- | --- |
| stage | 真实 XYZ stage driver |
| frame provider | LabSpec worker frame provider |
| autofocus | 单点 autofocus 复合动作 |
| spectrum acquisition | 单点采谱 |
| XY correction | future/reference only; not part of MVP runtime surface |
| mapping reference | 参考点执行顺序与 record 结构，不是最终 kernel |

关键判断：多点 workflow state 必须归 kernel/runtime contract 管，不能藏在 Python loop 里。

## 4. Raman 资源注册

Raman 接入的第一步不是写 tool，而是把真实硬件描述成稳定资源。

建议最少定义三类资源：

1. `stage`
2. `frame_provider`
3. `spectrometer`

如果未来把 camera、temperature controller、laser interlock 单独抽出，也应继续沿用同样模式。

### 4.1 示例：stage 资源

```yaml
resourceId: mc_newton_xyz_main
kind: stage
runtime: raman_python
driver: mc_newton_xyz
config:
  port: COM5
  xChannel: 1
  yChannel: 2
  zChannel: 3
  baudrate: 115200
leasePolicy: exclusive
simulationAvailable: true
limits:
  xRangeUm: [0, 50000]
  yRangeUm: [0, 50000]
  zRangeUm: [0, 5000]
```

### 4.2 示例：frame provider 资源

```yaml
resourceId: labspec_frame_main
kind: frame_provider
runtime: raman_python
driver: labspec_file_bridge_frame
config:
  bridgeDir: D:\\RamanLab\\SpecBridge
  imageFormat: tif
  minCaptureIntervalMs: 400
leasePolicy: shared-read
simulationAvailable: false
```

### 4.3 示例：spectrometer 资源

```yaml
resourceId: labspec_main
kind: spectrometer
runtime: raman_python
driver: labspec_file_bridge_spectrum
config:
  bridgeDir: D:\\RamanLab\\SpecBridge
  requestFilename: spectrum_request.ini
  resultFilename: spectrum_result.ini
leasePolicy: exclusive
simulationAvailable: false
```

关键原则：

- planner 不直接写这些 config
- `ProcedureSpec.resources` 只引用 `resourceId`
- runtime 负责把 `resourceId` 解析成真实 driver session

### 4.4 实验室默认配置与本地覆盖

Raman MVP rebuild 将实验室稳定硬件事实固化在可提交配置中：

```text
lab-config/raman-runtime.lab.json
```

该文件表达实验室默认资源、driver、端口、bridge 目录和 stage limits。
LabAgent 初始化时加载它，把设备能力与边界带入上下文。

如果某台机器需要临时覆盖端口、路径或启用状态，使用 git-ignored 本地文件：

```text
lab-config/raman-runtime.local.json
```

加载语义固定为：

```text
raman-runtime.lab.json + raman-runtime.local.json overrides > no live runtime
```

`raman-runtime.local.json` 是覆盖层，不是完整替代；常见用法是只覆盖
`pythonExecutable`、`stage.config.port` 或 LabSpec bridge 目录。若本机需要显式禁用
live hardware，在 local 文件中设置 `"enabled": false`。这避免把临时现场调整写回实验室默认配置。

`pythonExecutable` 应写绝对路径，避免不同 shell / conda 环境下裸 `python` 指向不确定。
默认使用 workspace-local `.venv`：

```json
{ "pythonExecutable": "C:\\RamanLab\\RamanLabWorkspace\\.venv\\Scripts\\python.exe" }
```

若某台机器必须使用不同环境，只在 `raman-runtime.local.json` 覆盖
`pythonExecutable`，不要把用户级 conda/base 路径写进 lab 默认配置。

Live runtime 使用的 Python 硬件驱动固定在：

```text
lab-config/drivers/raman-python
```

`raman-runtime.lab.json` 的 `pythonRoot` 应指向该目录。
该目录同时包含真实硬件 driver 所需的 vendor wheel：

```text
lab-config/drivers/raman-python/vendor
```

`docs/Raman` 与 `assets/manuals` 均为 reference/archive，不应改变 LabAgent 的真实硬件行为。

### 4.5 持久化 driver 会话（daemon 传输）

为支撑多点 mapping（如 10×10），Python live runtime 不再「每个 action 拉起一个进程并重连硬件」，
而是持有一个长生命周期的硬件 daemon：

```text
lab-config/drivers/raman-python/raman_runtime_daemon.py
```

TS 侧 `createRamanPythonRuntime` 在首个 action 时惰性 spawn 该 daemon 并保持存活，
stage 与 LabSpec frame 会话只在首次使用时连接、整个 run 复用；
spectrometer 若没有独立长连接，也必须由 daemon 串行管理 request/result bridge 的互斥、超时和恢复边界。
这把一次 N 点 mapping 的串口反复开关从 O(N) 级降到 session 级复用，
直接消除真实硬件上最主要的不稳定来源之一（串口反复开关导致的 port-busy / 握手延迟）。

该 daemon 传输固定遵循以下属性：

- **单一会话**：stage / frame provider 会话惰性创建并复用；spectrometer acquisition
  若按 action 创建，也必须挂在同一个 daemon 串行通道下。每次 stage 动作后 `disable_all_axes()`
  （动作间不留带电轴），但不断开串口；disable axes 不等于释放 lease 或断开 driver session。
- **串行访问**：所有 action 与 operator tool 共用同一 daemon，并在 TS 侧排队逐个执行，
  单一硬件会话永不被并发触碰。这是**传输层正确性保证**，不是策略级 lease；
  多 agent lease 仲裁仍属目标态（见 `implementation-plan.md` Open issues 4）。
- **超时恢复**：单 action 超时即 kill 并重置 daemon，下一个 action 重新 spawn。
  运动边界、物镜净空、激光功率等硬限制仍在 TS 侧每个 action 前强制校验，与传输方式无关。
- **空闲释放**：`daemon.idleShutdownMs`（默认 30000ms）无请求后 daemon 干净退出并释放串口，
  下个 action 再次 spawn。

daemon 仅从 `lab-config/drivers/raman-python` 下导入；`docs/Raman` 仍只作 legacy/reference。

## 5. Raman Driver 分层

本文把 Raman 接入分成三层：

1. `DeviceDriver`
2. `CompositeAction`
3. `Tool Surface`

### 5.1 `DeviceDriver`

贴近设备原语，不理解实验目标。

#### Stage Driver

对外统一成少量稳定操作：

- `connect`
- `get_position`
- `move_absolute_and_wait`
- `move_relative_and_wait`
- `stop`
- `disconnect`

#### Frame Driver

对外统一成：

- `connect`
- `capture_latest`
- `disconnect`

不要把“启动 video session 后轮询 frame 文件夹”的细节泄漏给上层。

#### Spectrum Driver

对外统一成：

- `acquire_spectrum`
- `cancel_current`

MVP 不必一开始拆到 `begin / poll / collect`。

### 5.2 `CompositeAction`

这是比 driver 更高一层的设备侧有界动作。

#### Autofocus

建议暴露为一个动作：

- `autofocus.run_single`

返回：

- `status`
- `zBestUm`
- `finalScore`
- `confidence`
- `coarseCurveArtifact?`
- `fineCurveArtifact?`
- `message`

#### XY Correction（MVP 不实现，reference-only）

> XY correction 在当前 MVP 不接入。本小节保留为 reference，用于未来 mapping 累积误差补偿增量。详见 `implementation-plan.md` 的 Open issues。

未来若启用，建议暴露为：

- `xy_correction.estimate_and_apply`

返回：

- `dxUm`
- `dyUm`
- `confidence`
- `referenceFrameArtifact`
- `currentFrameArtifact`

#### Spectrum Acquisition Wrapper

建议暴露为：

- `spectrometer.acquire_spectrum`

返回：

- `status`
- `outputPath`
- `requestId`
- `workerResult`
- `durationS`
- `plotArtifact?`

### 5.3 `Tool Surface`

tool 不是 driver API 的镜像，只回答：

- planner 在实验层需要什么能力
- operator 在维护层需要什么能力

而不是“哪些 Python 函数存在”。

## 6. Planner / Operator Tool 分工

Raman 接入至少应区分两类 tool surface。

### 6.1 Planner-Facing Tools

planner 只能看到实验管理和实验能力入口，例如：

- `get_lab_capabilities`
- `validate_experiment_spec`
- `run_preflight`
- `run_experiment`
- `analyze_run`
- `plan_next_experiment`

这些 tool 的重点是：

- 让 planner 生成与发起 `ProcedureSpec`
- 不让 planner 直接碰 Raman driver

### 6.2 Operator / Maintenance Tools

operator 需要的不是完整实验入口，而是现场维护与证据链工具，例如：

- `poll_run`
- `pause_run`
- `abort_run`
- `raman_get_hardware_status`
- `raman_get_stage_position`
- `raman_capture_frame`
- `raman_run_autofocus`
- `raman_acquire_smoke_spectrum`
- `raman_stage_move_relative`
- `raman_active_probe`
- `raman_record_xy_calibration`（MVP 不实现，随 XY correction 一并推迟）
- `raman_fit_xy_calibration`（MVP 不实现，随 XY correction 一并推迟）
- `raman_check_hardware_validation`

这些 tool 可以有更明确的硬件意味，但仍然不应退化成裸驱动命令。
其中 `raman_stage_move_relative` 属于 operator 确认后的 stage-only nudge：
它应读取当前位置、计算目标、用 runtime stage resource limits 做硬边界校验；
它不应为了单轴移动构造 Raman 采谱 `ProcedureSpec`，也不应要求 frame provider / spectrometer 参与。
其中 `raman_capture_frame` 属于 operator 的现场观察能力：
它应通过 runtime 的 `frame.capture_latest` 复合 action 返回 frame artifact/path，
不应暴露 `start_video_session`、文件夹 glob 或相机底层驱动细节。
其中 `raman_run_autofocus` 属于 operator 的受控对焦能力：
它会产生真实 Z motion，必须显式确认，并应把 `minObjectiveClearanceUm` 合入 autofocus 的允许 Z 范围；
如果 autofocus 是正式 Raman run 的一部分，仍应由 bounded `ProcedureSpec` 执行。
其中 `raman_acquire_smoke_spectrum` 属于 operator 的 active probe / debug 能力：
它只用于确认当前采谱链路是否可用，必须显式确认激光曝光，并受固定低功率 debug 上限约束；
正式实验采集、参数搜索和 mapping 仍应走 bounded `ProcedureSpec`。

### 6.3 明确不暴露为 Planner Tool 的能力

下面这些不能直接给 planner：

- `move_absolute_um`
- `move_relative_um`
- `serial_send`
- `write_request_file`
- `set_laser_register`
- `start_video_session`
- `glob("frames/*.tif")`

如果这些能力进了 planner surface，Agent 就会直接开始拼驱动调用。

## 7. Raman Runtime Action 面

tool surface 之下，runtime 需要稳定 action contract。

建议 Raman runtime 至少收敛成下面几类 action：

### Stage

```text
stage.get_position
stage.move_absolute_and_wait
stage.move_relative_and_wait
stage.stop
```

### Frame

```text
frame.capture_latest
```

### Autofocus

```text
autofocus.run_single
```

### XY Correction（MVP 不实现，reference-only）

```text
xy_correction.estimate_and_apply
```

### Spectrometer

```text
spectrometer.acquire_spectrum
spectrometer.cancel_current
```

这些 action 是 runtime contract，不是 planner tool 名称。

## 8. Raman `ProcedureSpec` 里的领域参数应该怎样放

Raman 的领域参数应收敛在 typed `domain` block 里，而不是散落在顶层或工具参数里。

示例：

```yaml
procedureId: raman_grid_mapping
resources:
  stage: mc_newton_xyz_main
  spectrometer: labspec_main
  frameProvider: labspec_frame_main
limits:
  maxLaserPowerPercent: 1
  minObjectiveClearanceUm: 200.0
  # maxXyCorrectionUm: 5.0  # MVP 不实现，随 XY correction 一并推迟
plan:
  kind: grid_scan
  grid:
    origin: { xUm: 1000, yUm: 2000, zUm: 1500 }
    rows: 10
    cols: 10
    pitchXUm: 5
    pitchYUm: 5
    order: snake
  perPoint:
    - kind: move_to_point
    - kind: autofocus
    - kind: capture_frame
    - kind: acquire_spectrum
domain:
  raman:
    autofocus:
      enabled: true
      roi: { x: 200, y: 120, width: 180, height: 180 }
      params:
        # Raman lab optimized fixed-range autofocus path.
        zStartUm: 340
        zEndUm: 260
        pointCount: 10
        framesPerZ: 1
        warmupFramesPerZ: 1
        finalVerificationFramesPerZ: 1
    acquisition:
      integrationTimeS: 10
      accumulations: 1
      saveFormat: txt
      timeoutS: 30
      laserPowerPercent: 0.1
```

关键边界：

- `domain.raman` 承载 Raman 特有参数
- live `grid_scan` origin 必须包含固定 `zUm`；compiler 会把它复制到每个 point unit，
  不允许依赖 runtime 猜测当前 Z
- resource config 不由 planner 自由填写
- `laserPowerPercent` 是请求的 LabSpec 激光功率百分比档位
- `limits.maxLaserPowerPercent` 是本次 run 的安全上界
- Raman lab 的实际硬件功率不是连续值，spectrometer resource config 应声明允许的固定档位，例如 `0.01 / 0.1 / 1 / 3.2 / 5 / 10 / 25 / 50 / 100`
- `autofocus.params.zStartUm/zEndUm` 表示实验室优化过的固定 Z range autofocus；MVP live daemon 不再支持旧的 `coarseRangeUm/fineRangeUm` coarse/fine path。
- fixed-range autofocus 当前固定使用 10 点扫描；`pointCount` 可表达调用意图，但 daemon 会归一为有效 10 点，并在返回 payload 的 `params.effectivePointCount` / `params.effectiveSpacingUm` 中记录实际值。
- `warmupFramesPerZ` 表示每个 Z 采样点丢弃的预热帧数；`framesPerZ` 表示参与评分的帧数。file-backed frame provider 会尽量只保留代表评分帧，减少 bridge 目录堆积。

## 9. 预检与维护工具如何接 Raman

Raman 是真实硬件，因此只靠 `approve_and_start_run` 不够，还需要 operator-only 的维护入口。

### 9.1 Read-Only Preflight

应检查：

- stage 能否连接并读位置
- frame bridge 目录可用性
- spectrum bridge 目录可用性
- 编译后的每个 live absolute point 是否具有完整 X/Y/Z 和可执行 action 参数
- grid compiler 先把计算坐标量化到固定精度，再做精确 motion range 比较；
  runtime 在每个 action 前仍使用未经扩大的同一硬边界

MVP rebuild 中，普通状态读取应优先通过 operator tool 完成：

- `raman_get_hardware_status` 返回 runtime 注册状态、preflight readiness、control availability、资源 id 和当前 stage position（若可读）。
- `raman_get_stage_position` 只读取当前 X/Y/Z 坐标。

这两类读取不应要求 agent 构造 `ProcedureSpec`，也不应退回 legacy bridge。

### 9.1.1 Confirmed Stage Nudge

实验现场常见的“小幅移动 stage”不是 Raman 采谱 run。
MVP rebuild 应提供单独的 operator tool：

- 输入：`axis`、`deltaUm`、可选 `timeoutMs`、确认标志
- 读取当前 stage position
- 计算目标 position
- 校验 runtime stage resource limits
- 未确认时只返回目标和风险，不执行移动
- 确认后调用 runtime `stage.move_absolute_and_wait`

该入口仍然是受控硬件动作，但不属于 `raman_single_point_probe`、`raman_parameter_search` 或 `raman_grid_mapping`。

### 9.2 Active Probe

应允许 operator 显式做：

- 抓一张真实 frame
- 做一条最小 smoke spectrum

但这类动作不能混入 planner 的 dry-run 语义。

### 9.3 Calibration Tools（MVP 不实现，随 XY correction 一并推迟）

> 标定工具链服务于 XY correction，当前 MVP 不接入。本小节保留为 reference。

Raman 特有但很现实的一类维护操作是标定：

- 记录 XY calibration
- 拟合 calibration
- calibration artifact review is future/reference only

这些操作不属于 planner 的日常实验策略，而属于 operator / maintenance surface。

## 10. Artifact 策略

Raman 接入时，必须明确哪些产物由 runtime 产出并登记。

MVP 最小必需产物应包括：

- frame 原图
- autofocus coarse/fine 曲线
- spectrum 原始 txt
- spectrum plot
- LabSpec request/result 文件

> `XY correction reference/current frame` artifacts remain future/reference only and are outside the MVP artifact baseline.

这里的原则是：

- 产物可以由 runtime 生成
- 但必须通过结构化 artifact ref 回流
- 不能靠 message 文本告诉上层“文件大概在某个目录里”

## 11. 错误模型

Raman 接入必须把 Python 异常归一化成结构化错误码，而不是把 traceback 暴露给 kernel 或 Agent。

MVP 最小错误模型建议至少区分：

- `stage_connection_error`
- `stage_timeout`
- `frame_timeout`
- `autofocus_no_peak`
- `autofocus_low_confidence`
- `spectrum_request_pending`
- `spectrum_timeout`
- `worker_result_error`
- `bridge_protocol_error`

> `xy_correction_low_confidence` remains a future/reference error code and is outside the MVP error surface.

除领域错误外，daemon 传输层（§4.5）还会归一化以下进程级错误码，同样带三个布尔标志：

- `python_runtime_timeout`（单 action 超时，已 kill 并重置 daemon）
- `python_runtime_spawn_failed`（daemon 进程无法启动）
- `python_runtime_exit_failed`（daemon 进程异常退出）
- `python_runtime_closed`（daemon 在 action 完成前被关闭）
- `python_runtime_parse_failed` / `python_runtime_bad_request`（协议行无法解析）

并且每个错误至少带：

- `retrySafe`
- `needsOperator`
- `safeToResume`

## 12. 为什么 mapping runner 只能作为参考

legacy mapping runner 的点执行顺序、point record 和离线验证方式有参考价值，但它持有多点 workflow loop，
缺少统一的 kernel-level pause / abort / resume 契约，也不是围绕 `ProcedureSpec -> ExecutionUnit[]` 设计。
正确做法是借鉴 point sequencing / record，不直接把它当最终 runtime 或 kernel。

## 13. 推荐实施顺序

1. 固定 stage / frame provider / spectrometer 资源。
2. 收敛 stage / frame / spectrum drivers。
3. 收敛 autofocus 与 single spectrum acquisition wrapper；XY correction 推迟。
4. 整理 planner-facing experiment tools 与 operator-facing maintenance tools。
5. 校验这套分层能否平移到温控台、电化学或别的仪器。

## 14. 结论

`raman-hardware-adapter-contract.md` 应该收敛到下面这句话：

> Raman 的任务不是定义 kernel，而是把真实硬件资源、Python 驱动、设备侧复合动作和 planner/operator tool surface 串起来，形成一套可复用的接入模板。

kernel 的编译、执行、状态机和恢复边界，交给 `kernel-execution-model.md`。
