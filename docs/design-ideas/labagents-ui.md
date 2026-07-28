# LabAgents Operator UI（Planning）

当前代码尚未实现 instrument status widget。本文只定义第一版只读 UI 的边界与验收条件，不描述已经存在的产品能力。

## 1. 目标

operator 在聊天之外持续看到：

1. live runtime 是否注册、preflight 是否 ready、control 是否 available
2. stage 当前状态和 XYZ
3. frame provider / spectrometer 是否可用
4. 当前 active run 的独立摘要（若存在）

UI 服务现场态势感知，不替代 planner、operator tools 或 `RunState`。

## 2. 数据边界

三类事实必须分开：

| 事实 | 来源 | 回答的问题 |
| --- | --- | --- |
| instrument snapshot | runtime read-only queries | 设备现在怎样 |
| `RunState` | run store | 当前实验执行到哪 |
| `ProcedureSpec` | frozen spec store | 已批准要做什么 |

UI 不得：

- 从 `ProcedureSpec` 推断实时设备状态
- 把 runtime snapshot 写入 `RunState`
- 直接调用 driver
- 为了刷新而 capture frame、autofocus 或 acquire spectrum
- 把 unknown 值伪装成 ready/off/zero

## 3. 最小 `InstrumentSnapshot`

建议第一版只表达当前确实可读的数据：

```ts
type InstrumentSnapshot = {
  updatedAt: string
  runtimeRegistered: boolean
  preflightReady: boolean
  controlAvailable: boolean
  stage?: {
    status: "ready" | "busy" | "error" | "unknown"
    position?: { xUm: number; yUm: number; zUm: number }
    summary?: string
  }
  frameProvider?: {
    status: "ready" | "error" | "unknown"
    resourceId?: string
  }
  spectrometer?: {
    status: "ready" | "error" | "unknown"
    resourceId?: string
  }
}
```

当前 runtime 不能可靠读取 laser on/off 或实际功率，因此第一版不把猜测的 laser 状态放进 schema。

## 4. Runtime seam

UI 只调用一个 read-only helper，例如：

```text
readInstrumentSnapshot(cwd)
```

helper 负责：

- 获取 registered Raman runtime
- 调用 preflight
- 读取 stage position
- 将失败折叠为 snapshot status/summary
- 捕获异常，不让 UI timer 破坏 session

如果后续第二种仪器也需要同一 UI，再把它提升为 optional generic runtime method；第一版不提前抽象通用平台。

## 5. 刷新与并发

建议默认 1–2 秒刷新：

```text
timer tick
-> previous refresh still running? skip
-> read snapshot through serialized runtime channel
-> publish last complete snapshot
```

规则：

- 同一时刻最多一个 refresh in flight。
- 读取使用短 timeout。
- 与 live actions 共用 daemon queue，不并发触碰硬件。
- failure 保留 panel 并显示 error/unknown。
- session 结束时清理 timer。

## 6. 展示

建议通过 pi-agent extension UI 的 above-editor widget 展示：

```text
Raman: ready | control available | updated 12:03:41
Stage: ready | X=120.0 Y=35.0 Z=410.0 um
Frame provider: ready
Spectrometer: ready
```

active run 摘要如果加入，应作为独立数据块读取 `RunState`：

```text
Run: live-run-... | running | 12/100
```

instrument snapshot 与 run summary 可以同屏，但不能合并成一个事实对象。

## 7. 交互边界

第一版 panel 只读，不提供 motion、autofocus、laser 或 run-control buttons。

原因：

- effectful maintenance 已有确认过的 operator tools。
- run control 已有 pause/resume/abort 契约。
- UI 快捷按钮不能形成绕过 tool/kernel 的第二条执行路径。

未来若增加交互，也必须复用现有 tool confirmation 和 runtime hard limits。

## 8. 实施与验收

建议增量：

1. 定义 `InstrumentSnapshot` schema。
2. 实现 Raman snapshot helper。
3. 在 extension session lifecycle 注册/清理 widget timer。
4. 添加 in-flight guard 和 timeout。
5. 增加 runtime missing、position success、read failure、overlapping ticks 测试。

验收：

- 无 live runtime 时显示 unavailable/unknown，不抛错。
- 正常时显示真实 position 与 readiness。
- refresh 不触发 effectful action。
- slow refresh 不堆积并发请求。
- live run 与 UI 共享 daemon 时保持串行。
- session 结束后无残留 timer。

## 9. 暂不决定

- 是否需要独立 laser resource 与真实状态读取
- active run 使用同一 widget 还是独立 widget
- refresh interval 是否进入 workspace config

这些问题不阻塞只读 snapshot vertical slice。
