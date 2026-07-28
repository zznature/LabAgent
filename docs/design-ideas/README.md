# Design Ideas

`docs/design-ideas/` 是 LabAgents MVP 的规范性设计来源。这里记录当前成立的产品与技术契约，不保存已经完成的开发流水账，也不复制可由代码直接读取的完整 schema。

如果实现与设计冲突，应先澄清设计，再修改代码或文档；不能让实现静默替代设计。

## 阅读顺序与职责

| 文档 | 唯一职责 |
| --- | --- |
| `core-ideas.md` | 产品命题、核心原则、主链路和当前安全边界 |
| `core-object-model.md` | 核心对象、辅助契约、派生对象与持久化边界 |
| `kernel-execution-model.md` | 编译、准入、执行策略、生命周期、恢复和错误回流 |
| `raman-hardware-adapter-contract.md` | Raman 资源、driver、daemon、runtime action 和 tool surface |
| `run-observation-artifact-contract.md` | 当前 run records、artifact 索引和焦平面 provenance |
| `product_usage_example.md` | 用户视角下如何用多次 bounded run 推进 Raman 任务 |
| `implementation-plan.md` | 当前实现状态、待办与验收条件 |
| `labagents-ui.md` | 尚未实现的 operator-facing 状态 UI 边界 |

## 当前实现基线

- 唯一 MVP 扩展位于 `src/extensions/experiment-research`。
- 主链路是 `ExperimentIntent -> ProcedureSpec -> ExecutionUnit[] -> RunState`。
- simulation 与 `live-supervised` 共用 schema、kernel 状态机和 runtime contract。
- 当前 procedure 包括 Raman 单点采集、有界参数搜索、焦平面校准和 mapping。
- 真实 run 使用 proposal/hash 审批、冻结 spec、终态通知和受控 resume。
- planner-facing experiment tools 与 operator-facing maintenance tools 已分开。
- Raman live runtime 使用 workspace 配置、持久 Python daemon 和结构化 artifacts。
- UI 状态面板、同因硬件故障熔断、连接类自动重试和完整 lease 仲裁尚未实现。

精确字段与工具注册以当前 source schema 和 `index.ts` 为核对依据；设计含义仍由本目录定义。

## 维护规则

- 总纲不记录 Raman 数值参数；参数只在 Raman 专题或配置中出现。
- 对象文档描述字段职责，不手抄整份 TypeScript union。
- kernel 文档不描述 driver、串口或文件桥实现。
- Raman 文档不重新定义 kernel 状态机。
- 已完成事项从历史 phase 中移除，只在实现状态摘要中保留。
- 未实现设计必须显式标注，不得用将来时混入当前保证。
