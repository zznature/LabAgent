# Kernel 执行模型

本文定义 kernel 如何把已批准的 `ProcedureSpec` 托管为可观察、可中断、可恢复的实验运行。硬件资源、driver 与 Raman action 由 `raman-hardware-adapter-contract.md` 定义。

## 1. 职责边界

kernel 负责：

- 校验准入并冻结批准后的 spec
- 将 `ProcedureSpec` 编译为稳定 `ExecutionUnit[]`
- 选择确定性执行策略
- 推进 run lifecycle
- 持久化 `RunState`、events 与 artifact refs
- 协调 pause、abort、resume、retry 与点间等待
- 把 runtime 结果折叠成实验级状态

kernel 不理解研究假设，不生成实验方案，不持有 driver session，也不让 LLM 进入 unit 执行热路径。

## 2. 编译契约

```text
frozen ProcedureSpec
-> normalize plan
-> expand finite units
-> attach actions, limits and metadata
-> validate domain invariants
-> ExecutionUnit[]
```

当前 plan 编译：

| plan | 编译结果 |
| --- | --- |
| `current_position` | 一个 positionRef=current 的 point unit |
| `point_list` | 显式 points 或 line generator 展开的 point units |
| `grid_scan` | row-major 或 snake point units |
| `focus_plane_calibration` | progressive XY waypoints 与五个 fit anchors |

编译必须保证：

- unit ID、index、resume key 和 artifact scope 稳定。
- actions 停留在 `move_to_point / autofocus / capture_frame / acquire_spectrum` 语义层。
- spec limits 被带入每个 unit；runtime/driver 仍承担最终硬防线。
- focus-corrected mapping 点位于冻结有效区域内，并写入 predicted Z。
- 新 mapping 默认不启用焦平面，省略校正字段不再阻止编译或批准前校验；新 proposal 在哈希计算前显式保存 `disabled/default_disabled`。
- 禁用焦平面的 local mapping 可仅编译 XY，在 runtime 使用首次移动前实测 Z / 最近成功焦点作为实际移动与聚焦中心；显式 `fixed_absolute` 仍要求计划 Z。
- 已知中心的 autofocus 完整窗口位于 approved Z limits 内；禁用焦平面的 local mapping 在编译时检查宽度可容纳，preflight/runtime 再检查实测中心对应的完整窗口。
- calibration 不能被 `maxUnits` 截断到无法发布模型。
- 编译结果通过 `ExecutionUnit` schema 校验。

## 3. Proposal、准入与冻结

proposal store 已保存完整 spec 与 `specHash`。批准调用只提交：

```text
proposalId + specHash + execution mode
```

`live-supervised` 还要求：

- `preflightReady = true`
- `controlAvailable = true`
- operator acknowledgement 精确复述 proposal ID 与 hash

通过后，kernel 保存或复用同 hash 的 frozen spec，再启动 run。proposal 不存在、已批准/被替代、hash 不匹配或 frozen spec 内容不一致都 fail closed。

`revise_proposal` 对 pending spec 应用 merge patch、重新校验并产生新 proposal；旧 proposal 进入 `superseded`，批准不继承。

## 4. Run lifecycle

状态集合：

```text
queued -> running -> completed
                  -> paused -> running
                  -> failed
                  -> aborted
```

关键操作：

- start：创建 base `RunState`，异步执行 units。
- poll / summarize：读取持久化快照，不依赖内存 active run。
- pause：在 unit/action checkpoint 或点间等待边界生效。
- abort：终止剩余 units，不用于“暂停后继续”。
- resume：从 paused unit 继续，不重置已有 progress、attempts 或 artifacts。

pause/abort 请求不能靠中断前台函数模拟；runtime action 必须返回明确状态，kernel 在认可边界更新 run truth。

## 5. Resume 契约

resume 只接受 `runId`：

1. 读取 paused `RunState`。
2. 读取磁盘上的 frozen `ProcedureSpec`。
3. 重新编译并应用原 `maxUnits` 边界。
4. 校验 `units[currentUnit.index].unitId` 与快照一致。
5. 从该 index 重建 active run，并保留原状态数据。

禁止：

- 调用方重传或修改 spec
- 指定任意 resume index
- 用 abort + re-propose 冒充继续

`live-supervised` resume 会重新触发真实硬件动作，因此工具先展示恢复 unit/坐标，再要求 `confirmed=true`。

## 6. 执行策略

### 6.1 Linear

单点与 calibration 按 unit 顺序执行。任一未处理 failure 使 run failed；operator pause 或 runtime paused 使 run paused。

### 6.2 Parameter search

- attempts 由批准 envelope 与 `maxAttempts` 有限生成。
- 每次 acquisition 参数必须落在 envelope 内。
- 每次结果必须带结构化 observation metrics。
- 显式规则返回 `acceptable`、`continue_search_within_envelope` 或 `stop_and_request_user_decision`。
- acceptable 提前完成；需要用户判断时 pause；不存在自由发挥或无界扩展。

### 6.3 Mapping

mapping 使用 point-level attempt history：

1. initial attempt
2. policy 允许时的 immediate retry
3. 主扫描结束后的 final retry queue

当前可重试分类为 timeout、position feedback 和 low focus confidence。`autofocus_position_feedback` / `stage_position_feedback` 且 `retrySafe = true` 归为 `execution / position_feedback`：读数 10 秒未稳定、聚焦重新读取距目标超过 10 µm、采图前后差值超过 5 µm 时，重做该 XY 点的整轮聚焦，复用其原窗口与现有 immediate/final 次数，不在 Python 内增加 Z 样本重试。新默认 execution reasons 包含 `position_feedback`；既有只列出 `timeout` 的冻结策略也沿用其恢复次数，显式 0 次仍禁止重试。超出扫描边界容差与一般 SDK 错误不会因此获得重试。最终失败可按 `stopOnError` 立即结束，或记录失败点继续；连续失败达到 `maxConsecutiveFailures` 时 run failed。

已完成点、失败点和每次 attempt 都写入状态/事件，成功 retry 不覆盖先前失败证据。

重试额度按每点的失败阶段独立计算：`stage_*` / `move_timeout` 属于 `move`，`autofocus_*` / `low_focus_confidence` 属于 `autofocus`，其余既有可重试错误共用 `other` 额度。每组各自应用冻结策略的 `maxImmediateRetriesPerPoint` 和 `maxFinalRetriesPerPoint`，切换错误类型或阶段不会刷新已经使用的次数。聚焦中的 Z 移动、反馈和质量失败均使用同一聚焦额度，不按 execution/quality 另分。结束后补测阶段只使用 final 额度，不重新开放 immediate 额度。

例如立即重试上限为 1、final 为 0：移动失败 → 移动重试成功但聚焦失败 → 仍可再重做该点整轮聚焦；若这次移动再次失败，移动额度已耗尽，不能借用聚焦额度无限重试。实际仍按整个 XY 点重新执行，不把 Python 内的补发次数计入 kernel 的整点重测。

每次准许重试时，先在失败记录中保存 `pointAttempts[].scheduledRetry = { stage, phase }`，再执行或排队，次数从持久化记录统计。`attemptIndex` 是整点尝试的全局递增编号，不再充当某阶段的重试计数。暂停恢复沿用原额度、原窗口、下一 attempt 编号，并恢复此前排队的 final retries。旧快照没有该字段时，根据其失败记录、旧全点编号与冻结策略恢复原先已准许的重试，不能从零开始计数。

固定范围聚焦内部执行 10 点扫描、必要时一次 5 点细化及最终质量验收；验收不通过时，runtime 在采谱前返回可重试的 `autofocus_low_confidence`。kernel 复用上述 immediate/final retry 策略，不与 Python 内部整点重扫叠加。立即重测一次、无结束后补测对应 `maxImmediateRetriesPerPoint = 1`、`maxFinalRetriesPerPoint = 0`；未声明策略时的默认值仍为立即一次加结束后一次，显式冻结策略优先。

低质量失败不更新 accepted focus Z。禁用焦平面的 local mapping 在首次移动前保存 `initialFocusZUm`，每点移动前保存 `mappingFocusWindows[unitId]`；立即重测、结束后补测与暂停恢复复用该点原窗口，不能从失败后当前位置或后来点的成功焦点重新定中心。workspace 为每次聚焦保存独立 artifact 文件与 ID，`pointAttempts[].artifactIds` 可追溯失败和重测证据。具体文件名、质量门槛与中心策略见硬件适配契约 5.4–5.5。agent 配置策略，确定性 kernel 在执行热路径触发重测；不需要 agent 收到每次失败后再发起调用。

## 7. 点间等待与控制请求

`grid_scan` 和 `point_list` 可声明 `interPointDelayMs`：

- 当前 unit 完成后、下一 unit 开始前等待。
- 最后一个 unit 后不等待。
- 等待期间继续响应 pause/abort。
- 它是调度语义，不是 driver timeout 或通用 sleep step。

## 8. Runtime contract

kernel 向 runtime 提交：

- current unit
- frozen spec context
- semantic action
- timeout/cancel 约束
- strategy-specific override（例如 parameter-search acquisition）

runtime 返回：

- `completed / failed / paused`
- artifacts
- observation/evaluation data
- structured error

错误至少包含：

- `errorCode`
- `message`
- `retrySafe`
- `needsOperator`
- `safeToResume`
- optional scope/payload

kernel 用这些字段决定 retry、pause、fail 或 resume。traceback、SDK object、bridge filename 和串口细节不能成为控制信号。

agent 可见 tool summary 必须带出 error code、message 与关键数值；内部 details 或 event log 不能成为唯一诊断来源。

## 9. 状态、事件与终态通知

每个 run 分开维护：

- `run-state.json`：当前快照
- `events.jsonl`：append-only lifecycle/attempt 事件
- `artifacts.jsonl`：append-only artifact index
- payload files：真实产物

heartbeat 与 progress 属于状态，不等于日志。大文件只通过 artifact ref 回流。

run 进入 paused、failed、completed 或 aborted 时，terminal observer 主动把诊断摘要送回会话；不推送每个 unit 的心跳，避免打断 agent。`poll_run` 仍保留为显式查询入口。

## 10. Simulation

simulation 与 live runtime 共用：

- `ProcedureSpec` / `ExecutionUnit` / `RunState` schema
- approval/freeze gate
- lifecycle 与执行策略
- event/artifact/error contract

simulation controls 只用于注入延迟、低置信、timeout、pause 和评估 observations，不能形成另一套产品语义。

## 11. 当前缺口

以下尚未实现，具体排期见 `implementation-plan.md`：

- 按 `errorCode + axis` 识别持续同因硬件故障并快速 pause
- 连接类 `retrySafe` 错误的有限自动重试
- autofocus 参数适用性校验
- calibration anchor gate 与实际噪声/首 unit 语义的重新收敛

这些缺口不应通过 prompt 里的临时重试或放宽 frozen spec 解决。
