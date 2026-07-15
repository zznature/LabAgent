# Design Ideas Map

`docs/design-ideas/` 是 LabAgents MVP rebuild 的设计来源。实现应优先服从这里的文档；
如果代码与设计冲突，先回到本文档目录澄清，而不是让实现暗中替代设计。

## Recommended Reading Order

1. `core-ideas.md`
   - 总纲：产品能力、主链路、核心数据边界、context、仪器接入和最小安全观。
2. `core-object-model.md`
   - 数据模型：`ExperimentIntent`、`ProcedureSpec`、`RunState`，以及 planner 侧 `ExperimentProcedureTemplate`。
3. `kernel-execution-model.md`
   - 执行模型：`ProcedureSpec -> ExecutionUnit[] -> RunState`，包括 retry、pause / abort / resume、runtime contract、artifact 和错误回流。
4. `run-observation-artifact-contract.md`
   - 观察与产物：Run Records Module、attempt/accepted attempt、固定 artifact layout、canonical profiles 和前端读取 interface。
5. `raman-hardware-adapter-contract.md`
   - Raman 接入样板：真实硬件资源、Python driver、daemon 传输、runtime action、planner / operator tool surface。
6. `product_usage_example.md`
   - 产品流程样例：用户如何从状态检查、单点采谱、参数搜索推进到 bounded mapping。
7. `implementation-plan.md`
   - MVP rebuild 路线：phase 切分、完成条件、当前已落地项和仍未冻结的 open issues。
8. `labagents-ui.md`
   - UI 规划：operator-facing instrument status panel、`InstrumentSnapshot` 和只读刷新边界。

## Document Roles

- `core-ideas.md` 定方向和边界。
- `core-object-model.md` 定主链路对象和 planner 侧模板。
- `kernel-execution-model.md` 定 kernel 如何托管执行。
- `run-observation-artifact-contract.md` 定 run 观察 interface、attempt 结果选择和正式 artifact contract。
- `raman-hardware-adapter-contract.md` 定真实 Raman 硬件如何接入。
- `product_usage_example.md` 定产品体验和 bounded run 交互节奏。
- `implementation-plan.md` 定可执行 rebuild 路线和验收状态。
- `labagents-ui.md` 定实验现场 UI 的只读观察面。

## Current Design State

- MVP 主线已收敛为：
  `ExperimentIntent -> ProcedureSpec -> ExecutionUnit[] -> RunState`。
- `ExecutionUnit` 是 kernel 从 `ProcedureSpec` 派生的运行时对象，不是第四个核心交互对象。
- `ProcedureSpec` 是声明式实验方案，不是脚本，也不是底层 driver 命令集合。
- 用户批准后，bounded run 执行冻结后的 `ProcedureSpec`；run 内不热改 spec。
- Raman MVP 已明确区分 planner-facing experiment tools 与 operator-facing maintenance tools。
- Raman live runtime 从 `lab-config/drivers/raman-python` 接入，`docs/Raman` 只作为 legacy/reference。
- 实验室默认硬件配置放在 `lab-config/raman-runtime.lab.json`，本机覆盖放在 git-ignored 的 `lab-config/raman-runtime.local.json`。
- planner 侧参数模板放在 `lab-config/templates/*.json`，模板 provenance 只进入 proposal / validation details，不污染可执行 `ProcedureSpec`。
- Run Observation 与固定 artifact contract 已完成 proposed MVP 设计，代码尚待按 `implementation-plan.md` Phase 11 分阶段替换。
- XY correction、完整 lease、多角色审批和监督人在场仍属于目标态或 future/reference，不进入当前 MVP 主链路。
