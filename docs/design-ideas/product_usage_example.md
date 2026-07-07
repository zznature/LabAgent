# LabAgent product usage example

本文不是协议定义，而是产品视角下的使用案例，用来说明：

- 用户会如何和 LabAgent 对话
- agent 会在什么地方提议 bounded run
- 哪些动作需要用户确认
- Raman mapping 任务会怎样被拆成多次受监督运行

## Product assumptions for this example

本例默认以下前提：

1. agent 可以提议下一次 bounded run，也可以执行已经批准的 bounded run。
2. agent 不能在运行中热改 `ProcedureSpec`，也不能无界扩展搜索空间。
3. 风险提示先分成三类：
   - `notice`：提示用户注意，但不阻断
   - `confirm_required`：必须经用户确认才能执行
   - `forbidden`：当前不允许执行
4. “合适条件”先按显式规则判断，不先交给 LLM 自由发挥。
5. 一个完整 Raman 任务通常不是一次 run 完成，而是由多次 bounded run 串成：
   - 定位 / 观察
   - 单点采谱
   - 参数搜索
   - mapping

## Raman mapping task example

### Phase 0: inspect lab state

1. user: 告诉我现在仪器状态。
2. agent:
   - Stage：`available`
   - Current position: `{x, y, z}`
   - Safety summary: `{z ceiling, current objective clearance, motion limits}`
   - Raman resources:
     - spectrometer: `ready`
     - frame provider: `ready`
     - laser: `{current power setting if readable}`
   - active lease: `none`
   - next suggestion: 可以先做只读观察，或者提议一次单点采谱 run。

### Phase 1: move to a candidate region and prepare a single-point acquisition

3. user: 向右移动 50 um，在新位置采一条谱。
4. agent:
   - 你的目标可以拆成两部分：
     1. `move_to_point`
     2. `single_point_acquire`
   - 检测到这是 effectful hardware action，需要先提议 bounded run。
   - 建议 run:
     - target point: `{x+50, y, z?}`
     - procedure: `raman_single_point_probe`
     - plan:
       - move_to_point
       - autofocus
       - capture_frame
       - acquire_spectrum
   - 默认采集参数:
     - laser power: `{param}`
     - integration time: `{param}`
     - accumulations: `{param}`
   - 风险提示:
     - `notice`: stage 将发生真实运动
     - `confirm_required`: 将触发激光与真实谱采集
   - 数据将保存到 `{planned output path}`
   - 请确认是否按这次 bounded run 执行。

5. user: 积分时间改成 300 s，开始采集。
6. agent:
   - 已更新提议，但这是新的 run 草案，不是对运行中 spec 的热修改。
   - 新参数:
     - integration time: `300 s`
     - expected runtime: `{estimated duration}`
   - 风险重新评估:
     - `notice`: 总实验时长增加
     - `confirm_required`: 长积分可能带来样品受热和资源长时间占用
     - `forbidden`: 如果 `300 s` 超过当前 limits.maxIntegrationTime，则拒绝并要求缩短
   - 如果参数仍在已批准范围内，请确认执行：
     - procedureSpecId: `{param}`
     - run type: `single_point_acquire`
     - save path: `{param}`

7. user: 确认执行。
8. agent:
   - 已启动 bounded run `{runId}`
   - occupied resources: `{stage, spectrometer, frame provider}`
   - current status: `running`
   - expected completion: `{eta}`
   - save path: `{param}`
   - 运行中不会自动扩大功率、积分时间、搜索区域或切换成 mapping。

9. agent:
   - run `{runId}` completed
   - resources released
   - artifacts:
     - frame: `{artifact}`
     - spectrum raw: `{artifact}`
     - plot: `{artifact}`
   - analysis summary:
     - autofocus confidence: `{param}`
     - saturation: `{true/false}`
     - snr: `{param}`
     - target peak score: `{param}`
   - next suggestion:
     - 如果规则满足，可以以该点为中心提议 mapping
     - 如果规则不满足，可以在已批准参数包络内提议 parameter search

### Phase 2A: parameter search when current conditions are not yet good enough

10. user: 如果这条谱还不够好，你会怎么继续？
11. agent:
   - 我不能无界搜索，但可以提议一次受限 parameter search。
   - 可调参数仅限：
     - `laserPowerPercent`
     - `integrationTimeMs`
     - `accumulations`
   - 不会改变：
     - approved ROI
     - autofocus Z window
     - mapping geometry
   - 建议 run:
     - procedure: `raman_parameter_search`
     - max attempts: `{param}`
     - search envelope:
       - laser power: `{min ~ max}`
       - integration time: `{min ~ max}`
       - accumulations: `{choices}`
   - “合适条件”判断规则示例：
     - autofocus confidence >= `{threshold}`
     - not saturated
     - snr >= `{threshold}`
     - target peak / baseline >= `{threshold}`
     - 在最近 `N` 次中至少 `M` 次满足
   - 这个 run 需要新的用户确认，因为它引入了多次真实采集。

### Phase 2B: start mapping when the single-point conditions are acceptable

12. user: 谱线信号不错，以这个点为中心，开始采集 10 x 10 mapping，x 间距 10 um，y 间距 15 um。
13. agent:
   - 我将把这个目标整理成一次新的 bounded run，而不是在上一条单点 run 内直接扩展。
   - 建议 mapping spec:
     - procedure: `raman_grid_mapping`
     - center: `{current approved point}`
     - grid: `10 x 10`
     - pitchXUm: `10`
     - pitchYUm: `15`
     - per-point actions:
       - move_to_point
       - autofocus
       - capture_frame
       - acquire_spectrum
   - 继承的采集参数:
     - laser power: `{param}`
     - integration time: `{param}`
     - accumulations: `{param}`
   - 风险提示:
     - `notice`: 总时长显著增加
     - `confirm_required`: stage 将在网格范围内连续真实运动
     - `confirm_required`: 将进行多点激光采集
     - `forbidden`: 如果任一点规划越过 Z / motion / power limits，则拒绝启动
   - 预估:
     - total points: `100`
     - expected duration: `{eta}`
     - save root: `{param}`
   - 请确认是否启动该 mapping run。

14. user: 确认执行 mapping。
15. agent:
   - 已启动 mapping run `{runId}`
   - current status: `running`
   - progress: `0 / 100`
   - occupied resources: `{stage, spectrometer, frame provider}`
   - run policy:
     - supervised mode only
     - operator may pause / abort at safe boundaries
     - no automatic expansion beyond approved grid

16. agent:
   - progress update: `35 / 100`
   - last completed point: `{row, col, x, y}`
   - recent health:
     - autofocus low-confidence count: `{param}`
     - spectrum failures: `{param}`
   - if needed: 可以由用户选择 pause / abort，但系统不会擅自扩大或改写 grid。

17. agent:
   - mapping run `{runId}` completed
   - resources released
   - outputs:
     - spectra directory: `{artifact}`
     - mapping summary: `{artifact}`
     - run summary: `{artifact}`
   - final summary:
     - completed points: `{param}`
     - failed points: `{param}`
     - usable points: `{param}`
   - next suggestion:
     - review mapping quality
     - if needed, propose a new bounded follow-up run focused on a smaller region

## What this example implies for product design

这个案例隐含了几个重要产品约束：

1. 用户看到的是“任务推进”，但系统内部必须拆成多次 bounded run。
2. agent 可以主动提议下一步，但每次新的 effectful hardware run 都必须经过确认。
3. 单点采谱成功，不等于系统可以自动开始 mapping；mapping 仍然是一次新的批准。
4. parameter search 必须有明确 envelope，不能变成无界自动调参。
5. 风险提示不只是报错文案，而要参与 run 是否允许启动的判定。

## Open questions still worth freezing later

这个例子已经足够支持第一版 build，但后续仍值得继续冻结：

1. “合适条件”的默认阈值由谁配置：用户、实验模板还是设备配置？
2. mapping 中如果出现连续低置信度 autofocus，默认是继续、暂停还是转人工？
3. parameter search 的默认最大尝试次数是多少？
4. mapping 允许跳过失败点，还是一旦连续失败就停止整次 run？
