# LabAgents 产品使用示例

本文从用户视角说明 Raman 任务如何由观察、维护动作和多次 bounded run 推进。协议字段以其他设计文档为准。

## 1. 使用前提

- agent 可以提出 bounded run，也可以执行用户已经批准的 proposal。
- agent 不能代替用户批准真实 motion/laser action。
- run 内不热改 spec，不无界搜索，不自动扩张 mapping。
- `notice / confirm_required / forbidden` 参与 proposal review。
- “是否足够好”由显式指标规则判断，不由 LLM 自由判断。

## 2. 观察与维护

用户：

> 告诉我当前仪器状态，并把载物台移动到候选位置。

agent：

1. 用 `raman_get_hardware_status` / `raman_get_stage_position` 读取现场状态。
2. 展示 absolute target、delta、limits 和 tolerance。
3. 用户确认后，用一次 `raman_stage_move_absolute` 完成闭环定位并报告实测 residual。

读状态不构造 `ProcedureSpec`；stage-only maintenance 也不伪装成 Raman 采谱 run。relative tool 只用于用户真正要求的单轴 nudge。

## 3. 单点采集

用户：

> 在当前位置对焦并采一条谱。

agent 的正式流程：

```text
record ExperimentIntent
-> find parameter template
-> draft current_position ProcedureSpec
-> validate
-> preflight
-> propose_run
```

proposal 展示：

- procedure 与 actions
- acquisition/autofocus 参数
- resources 与 limits
- risks、estimated runtime 和 save path
- exact `proposalId + specHash`

用户确认 exact ID/hash 后，agent 调用 `approve_and_start_run`。run 在后台执行；终态主动回流 frame、autofocus 和 spectrum artifacts 以及质量摘要。

如果用户在批准前改积分时间，agent 使用 `revise_proposal`。revision 产生新 proposal/hash，旧批准不继承。

## 4. 有界参数搜索

当单点结果不满足显式质量规则时，agent 可以提出新的 `raman_parameter_search`：

- 只搜索已批准的 laser power、integration time 和 accumulation envelope。
- attempts 不超过 `maxAttempts` / `maxUnits`。
- 每次结果产生 observation metrics。
- `acceptable` 提前完成。
- `continue_search_within_envelope` 继续下一次。
- `stop_and_request_user_decision` 暂停并等待用户。

单点采集成功不自动授权参数搜索；参数搜索也不能自动开始 mapping。

## 5. Focus-plane correction 的选择

新 mapping 默认关闭焦平面校正，无需先标定或要求用户明确拒绝。需要校正时可选择以下可选路径。

### 5.1 用户已有三个 focused XYZ

- 一次性使用：`calculate_focus_plane_from_xyz_points`，纯计算，不创建 artifact。
- 跨 run 复用：显式确认后用 `register_operator_focus_plane_calibration`，产生标记为 operator-supplied 的 immutable artifact。

两种路径都以三点三角形为有效区域；系统不声称这些点经过 runtime autofocus 验证。

### 5.2 系统需要采集 anchors

agent 提出独立 `raman_focus_plane_calibration`：

- 冻结当前位置、seed、四角、中心和 waypoint span。
- compiler 插入 progressive waypoints。
- 五个 fit anchors 完成后发布 focus-plane artifact。

用户批准 calibration 只授权该 run，不授权后续 mapping。

### 5.3 默认关闭或用户拒绝 correction

默认记录 `surfaceCorrection = disabled / default_disabled`；用户明确拒绝时记录 `disabled / user_declined`。首点使用首次移动前的实测 Z，后续点继承最近成功焦点，每点窗口保存供重测和恢复使用。local mapping 可仅指定 XY，不必填写固定 Z。

## 6. Mapping

agent 根据用户给出的 geometry 提出 `raman_grid_mapping` proposal：

- grid 或 point-list/line generator
- acquisition parameters
- 默认关闭焦平面；用户要求校正时才附带 artifact/manual surface correction 和有效区域
- per-point `move -> autofocus -> acquire`
- stopping/retry rules
- expected points、duration 和 output root

显式启用校正时，compiler 把 predicted Z 写入每个 point unit。默认关闭不会阻止批准前校验；以下问题仍会阻止执行：

- 显式启用校正但 artifact identity/checksum/coefficients/region 不一致
- 已校正方案的点位超出 calibrated region
- motion、autofocus window 或 power 超出 limits

用户确认新的 proposal ID/hash 后才启动 mapping。运行中 kernel 维护 progress、attempts、artifacts 和失败点，不修改 grid 或参数。

## 7. Pause、resume 与失败

- operator 可请求 pause/abort；pause 不丢弃已完成点。
- paused run 优先使用 `resume_run`。
- live resume 先展示恢复 unit/坐标，再要求用户确认。
- resume 重读 frozen spec 并校验 unit identity，不接受新 spec 或任意跳点。
- run 终态主动通知；用户仍可用 `summarize_run` 查询完整进度、失败和 artifacts。

## 8. 产品不变量

1. 用户看到连续任务，系统内部可以是多次独立 bounded run。
2. 新的 effectful experiment run 必须获得新的 proposal approval。
3. 默认规划路径不等于 motion/laser 授权。
4. 参数搜索、calibration 和 mapping 都不能突破批准 envelope。
5. 跨 run evidence 必须显式引用，不依赖“最近一次”推断。
6. 人负责实验判断与批准，不负责轮询状态、复制整份 spec 或从日志中解析错误。
