# LabAgents UI 设计 （status: planning）

本文回答一个问题：

> LabAgents 在 pi-agent UI 中应该怎样展示实验室与仪器的实时状态？

它重点讨论 operator-facing UI，不讨论 planner 如何生成实验方案，也不讨论 kernel 如何执行 `ProcedureSpec`。

## 1. 第一性原理

LabAgents 的 UI 首先服务于实验操作，而不是服务于聊天展示。

实验操作中，人真正需要持续看到的是三类事实：

1. 当前实验环境是否可用
2. 关键仪器是否 ready / busy / error
3. 当前运行如果存在，kernel 执行到了哪里

这三类事实不能混成一个对象：

- 实验环境与仪器状态回答“现场现在是什么状态”
- `RunState` 回答“当前 run 执行到了哪里”
- `ProcedureSpec` 回答“agent 准备怎么做实验”

因此 UI 必须坚持一个边界：

> 仪器实时状态是 runtime 产生的只读观察快照，不是 planner 写入的实验方案，也不是 kernel 的 run state。

## 2. 当前 MVP UI 目标

MVP 阶段不追求完整实验室控制台，而是先把操作过程中最影响判断的状态显示出来。

推荐新增一个常驻 instrument status panel，刷新周期为秒量级，例如 1s 或 2s。

最小显示内容：

| 仪器 | 字段 |
| --- | --- |
| stage | `status`, `position` |
| laser | `status`, `power` |
| camera / frame provider | `status` |
| runtime | `registered`, `preflightReady`, `controlAvailable`, `updatedAt` |

示例 UI：

```text
Raman: ready | control available | 12:03:41
Stage: ready  X=120.0um Y=35.0um Z=410.0um
Laser: off    Power=0%
Camera: ready frame-provider:labspec_frame_main
```

如果某个状态暂时没有真实读数，应显示 `unknown`，不要用猜测值填充。

## 3. UI 层级建议

pi-agent 当前 extension UI 已支持 `setWidget()`、`setStatus()` 和 `setFooter()`。

仪器状态 panel 推荐使用：

```text
ctx.ui.setWidget("instrument-status", lines, { placement: "aboveEditor" })
```

原因：

- footer 适合短状态，不适合多仪器、多字段信息
- above editor panel 在用户输入前可见，适合作为 operator 观察面板
- panel 可以用多行表达 stage / laser / camera，不挤压聊天正文

不建议：

- 用 LLM tool 每秒刷新仪器状态
- 把状态写进聊天消息流
- 把仪器状态混入 `RunState`
- 把实时状态写进 `ProcedureSpec`

## 4. 数据模型

建议新增一个只读快照对象，例如 `InstrumentSnapshot`。

```typescript
type InstrumentStatus = "ready" | "busy" | "error" | "unknown";

type StageStatus = {
	status: InstrumentStatus;
	position?: {
		xUm: number;
		yUm: number;
		zUm: number;
	};
	summary?: string;
};

type LaserStatus = {
	status: InstrumentStatus | "armed" | "off";
	powerMw?: number;
	summary?: string;
};

type CameraStatus = {
	status: InstrumentStatus;
	frameProviderResourceId?: string;
	summary?: string;
};

type InstrumentSnapshot = {
	updatedAt: string;
	runtimeRegistered: boolean;
	preflightReady: boolean;
	controlAvailable: boolean;
	instruments: {
		stage?: StageStatus;
		laser?: LaserStatus;
		camera?: CameraStatus;
	};
};
```

该对象只表达“现在读到什么”，不表达“接下来要做什么”。

## 5. Runtime 契约

仪器状态应该从 runtime 读取，而不是从 UI 直接访问 driver。

MVP 可以先为 Raman 新增一个 helper：

```text
.pi/extensions/experiment-research/runtime/raman/status-snapshot.ts
```

职责：

1. 读取 `getRamanLiveRuntime(cwd)`
2. 调用 `runtime.preflight()`
3. 调用 read-only action，例如 `stage.getPosition`
4. 将 runtime / action failure 折叠成 `InstrumentSnapshot`
5. 保证 UI 调用该 helper 不会抛出未处理异常

长期更推荐在 runtime contract 中增加可选接口：

```typescript
readInstrumentSnapshot?(): Promise<InstrumentSnapshot> | InstrumentSnapshot;
```

这样 UI 不需要知道 Raman 的 stage、spectrometer、frame provider 如何组合。
Raman 只是第一种实现，后续其他实验系统也可以复用同一个 panel。

## 6. 刷新策略

秒级刷新足够，不需要毫秒级。

推荐默认：

- `refreshIntervalMs = 1000` 或 `2000`
- 每轮刷新必须串行，上一轮未结束时跳过下一轮
- 单次状态读取应有短 timeout
- UI 只显示最后一次完整快照
- 读取失败时保留 panel，但标记 `error` 或 `unknown`

原因：

- 仪器 read-only query 也可能占用通信通道
- 与 live run 共享 daemon / runtime 时，状态查询不能制造并发硬件访问
- operator 需要的是态势感知，不是高频示波器

推荐行为：

```text
timer tick
  -> if refresh already in flight: skip
  -> readInstrumentSnapshot(cwd)
  -> format lines
  -> ctx.ui.setWidget(...)
```

## 7. 与 RunState 的关系

instrument status panel 可以显示当前 active run 的摘要，但不能以 `RunState` 作为仪器状态来源。

推荐分工：

- instrument panel：显示设备现场状态
- run panel / run summary：显示 `RunState`
- tool result：显示一次操作的结果
- event log：记录历史事件

如果 UI 后续需要显示 run 进度，可以在 instrument panel 旁边或下方增加 run summary：

```text
Run: live_20260702_001 running  12/100 point
```

但这仍然是两个来源：

- run summary 来自 `pollRun()` / run store
- instrument status 来自 runtime snapshot

## 8. Raman MVP 状态来源

当前 Raman runtime 已有这些可用信息：

- `runtime.preflight()`
- `runtime.stage.resource`
- `runtime.stage.getPosition(...)`
- `runtime.frame.resource`
- `runtime.spectrometer.resource`

因此 MVP 可以先实现：

| UI 字段 | 来源 |
| --- | --- |
| `runtimeRegistered` | `getRamanLiveRuntime(cwd)` |
| `preflightReady` | `runtime.preflight()` |
| `controlAvailable` | `runtime.preflight()` |
| `stage.status` | `stage.getPosition` action status |
| `stage.position` | `stage.getPosition` payload |
| `camera.status` | `preflight` + frame resource presence |
| `laser.status` | spectrometer / preflight details，无法读取则 `unknown` |
| `laser.powerMw` | 真实 runtime 暴露前为空 |

不要为了 UI 显示而每秒 capture frame 或 acquire spectrum。
这些是 effectful / expensive action，不能当作状态刷新。

## 9. Operator 交互

MVP panel 只做只读显示，不做按钮控制。

原因：

- LabAgents 当前安全目标是 supervised execution，不是直接手动控制台
- effectful 操作仍应走 operator tool 或 approved run
- UI panel 的职责是帮助人判断现场，不是绕过 tool / kernel 边界

后续如果加入交互按钮，应遵守同样边界：

- read-only action 可以直接由 panel 触发
- effectful action 必须走确认流程
- 可能改变硬件状态的操作不能藏在 panel 刷新里

## 10. 实施顺序

推荐按以下顺序落地：

1. 新增 `InstrumentSnapshot` schema / type
2. 新增 Raman `readInstrumentSnapshot(cwd)` helper
3. 在 `experiment-research/index.ts` 的 `session_start` 注册 UI widget
4. 加入定时刷新与 in-flight guard
5. 为 snapshot helper 写单元测试，覆盖 runtime missing、stage position success、stage read failure
6. 后续再决定是否把 snapshot helper 上升为通用 runtime contract

这个顺序可以先验证真实操作体验，同时不提前抽象过度。

## 11. Open Issues

1. laser 是否应从 spectrometer resource 中独立拆成 `laser` resource？
2. camera 与 frame provider 是否应统一命名，还是 UI 显示 camera、runtime 保持 frame provider？
3. active run summary 是否需要并入同一个 panel，还是做独立 run status widget？
4. 多 agent / 多 session 同时打开 UI 时，状态读取是否需要 lease-aware read channel？
5. 状态刷新 interval 是否应写入 extension config？

这些问题不阻塞 MVP。当前优先把只读状态显示跑通。
