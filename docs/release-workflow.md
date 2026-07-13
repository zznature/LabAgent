# 开发与发布工作流（Development & Release Workflow）

本文档定义 LabAgents 的分支模型、版本规则、发布产物与实验室 PC 的部署/回退流程。
文件结构边界见 `docs/repo-structure.md`；本文只管"代码如何流动、版本如何发布"。

## 第一性原则

发布体系只需要回答三个问题：

1. **开发在哪里发生** —— `main` 分支，面向通用能力（仪器加载、控制、kernel 执行）。
2. **实验室运行什么** —— `raman` 分支上经实验室验证的、有明确版本号的发布。
3. **出错了怎么回退** —— 实验室 PC 上多版本并存，回退 = 从旧版本目录重新指向同一个 workspace。

分支解决的是**发布节奏**问题（main 可以随时演进，实验室只消费验证过的快照），
不是模块边界问题。通用代码与 Raman 代码的分离靠 `src/` 内的目录结构，不靠分支。

## 分支模型

```text
main   o───o───o───o(v0.2.0)───o───o───o(v0.3.0)───o──▶  通用开发主干
                    \                      \
raman                o(raman-v0.2.0)───x────o(raman-v0.3.0)──▶  实验室发布分支
                                       │
                                       x = 实验室热修复 raman-v0.2.1
                                           （cherry-pick 回 main）
```

- **`main`** —— 唯一的开发主干。所有通用功能（仪器加载、控制、执行模型）在这里开发。
  日常小改动直接提交 main；较大的 feature 用短生命周期分支，完成后合回 main 并删除。
- **`raman`** —— 长期存在的实验室发布分支。只接受两类提交：
  1. 从 main 合并一个**已打 tag 的发布点**（不是任意 HEAD）；
  2. 实验室现场的热修复（修完 cherry-pick 回 main）。
  raman 分支上不做功能开发。

## 版本规则

- 采用 SemVer（`X.Y.Z`），版本号存于 `package.json`，发布提交时更新。
- 两个 tag 命名空间：
  - **`vX.Y.Z`**（main）—— 通用发布：功能达到可发布状态、`npm run check` 与测试通过。
  - **`raman-vX.Y.Z`**（raman）—— 实验室发布：在实验室真机验证通过后打 tag。
- raman 的版本号**跟随它所基于的 main 发布号**：main 发 `v0.2.0`，实验室验证通过后打
  `raman-v0.2.0`；实验室热修复只递增 patch 位（`raman-v0.2.1`、`raman-v0.2.2`）。
  这样只有一条有意义的版本线，不会出现两套互相错位的编号。
- 所有 tag 用 annotated tag（`git tag -a`），message 写清本次发布的变化。

当前状态：实验室运行的即 `0.1.0`，对应 tag `raman-v0.1.0`（raman 分支的起点）。

## 发布产物

发布产物 = `git archive` 从 tag 导出的 zip 包，**不含开发文档**。
排除规则由 `.gitattributes` 的 `export-ignore` 声明（`docs/`、`AGENTS.md`、`CONTEXT.md`、
`assets/{agent_sessions,experiment_data,ppt}/`、`.cursor/`、`.agents/` 等）。
`RamanLabWorkspace/`、`todo.md` 等本身不被 git 跟踪，天然不会进入产物。

打包命令（在开发机上执行）：

```bash
git archive --format=zip --prefix=labagents-raman-v0.2.0/ \
  -o labagents-raman-v0.2.0.zip raman-v0.2.0
```

产物内容：`src/`、`deploy/`、`package.json`、`package-lock.json`、`tsconfig.json`、`README.md`。
建议将 zip 上传到 GitHub Releases，实验室 PC 直接下载，无需在实验室 PC 上操作 git。

## 通用发布流程（main → `vX.Y.Z`）

1. main 上功能收敛，`npm run check` 全绿，相关测试通过（`./test.sh`）。
2. 更新 `package.json` 版本号，提交（如 `chore: release v0.2.0`）。
3. `git tag -a v0.2.0 -m "..."`，push 分支与 tag。

## 实验室发布流程（raman → `raman-vX.Y.Z`）

1. 把 main 的发布点合入 raman：`git checkout raman && git merge v0.2.0`。
2. 打包一个**候选版本**，装到实验室 PC 的新版本目录（见下节），真机验证。
3. 验证通过 → `git tag -a raman-v0.2.0 -m "..."`，push，打正式 zip 并上传 Release。
4. 验证不通过 → 在 raman 上修复（或放弃合并），修复提交 cherry-pick 回 main。

### 实验室热修复

实验现场发现问题时，直接在 raman 分支上修复：

1. 在 raman 上提交修复，`npm run check` 通过。
2. `git tag -a raman-v0.2.1 -m "..."`，打包部署。
3. `git cherry-pick` 该修复回 main，避免下次合并时问题复发。

## 实验室 PC 部署与回退

实验室 PC 上多版本并存，共享同一个 lab workspace：

```text
C:\LabAgents\
  releases\
    labagents-raman-v0.1.0\    # 各版本自包含（含各自的 node_modules）
    labagents-raman-v0.2.0\
  RamanLabWorkspace\           # 唯一的 workspace，lab-config / lab-records 跨版本保留
```

### 安装新版本

```powershell
# 1. 解压 zip 到 releases\ 下的新目录
# 2. 在该目录内安装依赖（只装锁定版本，不跑生命周期脚本）
npm ci --ignore-scripts
# 3. 让 workspace 指向这个版本（重写 .pi/settings.json 的绝对路径、刷新 driver 副本；
#    不会覆盖 raman-runtime.local.json 与 user-prompts.md）
deploy\setup-workspace.ps1 -WorkspacePath C:\LabAgents\RamanLabWorkspace
# 4. 启动
deploy\run-labagents.ps1 -WorkspacePath C:\LabAgents\RamanLabWorkspace
```

### 回退

旧版本目录一直保留（node_modules 已装好），回退只有两步，
从旧版本目录重新执行：

```powershell
deploy\setup-workspace.ps1 -WorkspacePath C:\LabAgents\RamanLabWorkspace
deploy\run-labagents.ps1  -WorkspacePath C:\LabAgents\RamanLabWorkspace
```

`setup-workspace.ps1` 会把 `.pi/settings.json` 的扩展路径指回旧版本目录并刷新
driver 副本；`lab-config` 本地配置与 `lab-records` 实验记录不受影响。

### 回退兼容性规则

回退的真正风险不在代码，而在数据与配置格式：

- 修改 `lab-records/` 或 `lab-config/` 的 schema 时，保持**向后可读**
  （旧代码能读新版本写入的记录），或在发布说明中明确标注"回退到 vX.Y 之前需注意"。
- 磁盘紧张时至少保留最近两个已验证版本的目录。

## 一次性初始化（bootstrap）

从当前状态（只有 main、无 tag）建立本体系：

```bash
# 1. 在实验室当前运行的 commit 上打 0.1.0 tag（若实验室与 main HEAD 一致则用 HEAD）
git tag -a raman-v0.1.0 <commit> -m "Raman lab release 0.1.0"
# 2. 从该 tag 创建 raman 分支
git branch raman raman-v0.1.0
# 3. push 分支与 tag
git push origin main raman --tags
```
