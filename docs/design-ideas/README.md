# Design Ideas Map

`docs/design-ideas/` 当前建议按下面顺序阅读：

1. `core-ideas.md`
   - 总纲：系统目标、边界、最小安全观
2. `core-object-model.md`
   - 核心对象：`ExperimentIntent`、`ProcedureSpec`、`RunState`
3. `kernel-execution-model.md`
   - 执行模型：`ProcedureSpec -> ExecutionUnit[] -> RunState`
4. `raman-hardware-adapter-contract.md`
   - 领域样板：Raman 硬件资源、driver、runtime action、tool surface

一句话分工：

- `core-ideas.md` 定方向
- `core-object-model.md` 定对象
- `kernel-execution-model.md` 定执行
- `raman-hardware-adapter-contract.md` 定硬件接入样板
