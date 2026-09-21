# Raman 温控整体控制协议

## 1. 目的和边界

Raman 实验中的温度控制由两类设备协同完成：

```text
Stirling 制冷机
    -> 提供基础制冷、启动/停止和制冷机状态
Kelvinion mini 温控仪
    -> 读取传感器、设定目标温度、控制升温速率和加热输出
样品/冷头热系统
    -> 在制冷和加热共同作用下达到目标温度并保持稳定
```

Kelvinion 的完整命令表和 Python 对照见
[kelvinion_mini_protocol.md](./kelvinion_mini_protocol.md)。本文只引用 Kelvinion
能力，集中记录 Stirling 的控制面、两者的协同顺序和当前协议边界。

本文区分三种事实：

- **VI 证据**：可以从厂家提供的 LabVIEW VI 中直接看到的设备或功能。
- **协同建议**：为形成安全控制链路而提出的确定性顺序，尚未代表现有 VI 已经实现。
- **待验证**：需要在目标设备上抓取串口数据或运行厂家 VI 后才能冻结的协议细节。

## 2. 设备职责

### 2.1 Stirling 制冷机

Stirling 侧负责基础制冷和制冷机自身的运行管理。VI 文件名显示它至少包含两种型号或控制器路径：CT-5221 和 CT-5505。

| 能力 | CT-5221 | CT-5505 | VI 证据 |
| --- | --- | --- | --- |
| 开机/停机 | 有开机 VI | 有开关机 VI | `Stirling v1.0/.../开机-CT5221.vi`、`开关机 - CT5505.vi` |
| 冷头温度 | 有 | 未见同名根目录 VI | `冷头温度读取-CT5221.vi` |
| 热头温度 | 有 | 有 | `热头温度读取-CT5221.vi`、`热头温度读取-CT5505.vi` |
| 控制器温度 | 有 | 有 | `控制器温度读取-CT5221.vi`、`控制器温度读取-CT5505.vi` |
| 环境温度 | 有 | 有 | `环境温度读取-CT5221.vi`、`环境温度读取-CT5505.vi` |
| 电机温度 | 有 | 有 | `电机温度读取-CT5221.vi`、`电机温度读取-CT5505.vi` |
| 电机状态 | 有 | 未见同名根目录 VI | `电机状态读取-CT5221.vi` |
| 输出功率 | 有 | 有功率读取 VI | `输出功率读取-CT5221.vi`、`功率读取-CT5505.vi` |
| 输出电流 | 有 | 有电流读取 VI | `输出电流读取-CT5221.vi`、`电流读取-CT5505.vi` |
| 工作电压 | 有 | 有 | `工作电压读取-CT5221.vi`、`工作电压读取-CT5505.vi` |
| 工作频率 | 有 | 有频率读取 VI | `工作频率读取-CT5221.vi`、`频率读取-CT5505.vi` |
| 设定电压 | 未见同名根目录 VI | 有 | `设定电压 - CT5505.vi` |

这些 VI 证明了 Stirling 的观测和维护能力，但没有证明 CT-5221 与 CT-5505 的寄存器、帧格式或单位完全相同。

### 2.2 Kelvinion mini 温控仪

Kelvinion 侧负责实验温度回路：

- 选择传感器通道；
- 设定温度和温度 ramp；
- 选择输出范围；
- 读取当前温度、设定值、功率和控制回路；
- 在自动或手动模式下管理加热输出；
- 在目标范围内执行稳温判断。

协议细节、命令大小写、终止符和 Python 映射不在本文重复，统一以
[kelvinion_mini_protocol.md](./kelvinion_mini_protocol.md) 为准。

## 3. Stirling 通信层

### 3.1 初始化

`Stirling_Init.vi` 使用 LabVIEW VISA Configure Serial Port。其面板包含：

- VISA resource name；
- baud rate，面板标注为 `9600`；
- data bits `8`；
- parity 选项，默认选项为 `None`；
- stop bits `1`；
- termination char `0x0A`（LF）；
- Enable Termination Char。

这组值是 VI 面板证据。终止字符开关的默认状态、实际连线值和 CT-5221/CT-5505 的现场串口配置仍需验证，不能直接替代设备通信记录。

### 3.2 数据转换

Stirling 的 VI 没有像 Kelvinion 那样暴露成 `[READ:...]` / `[SET:...]` ASCII 命令。通信由两个辅助 VI 完成：

| 辅助 VI | 作用 | 当前结论 |
| --- | --- | --- |
| `Stirling_Data2Str.vi` | 将控制数据或读写字段转换成 VISA 使用的字符串/字节序列 | 具体字段顺序、地址和校验未冻结 |
| `Volt - HEX.vi` | 将 CT-5505 设定电压转换成十六进制表示 | 具体缩放、字节序和校验未冻结 |

因此，Stirling 的正式协议目前只能冻结到“功能命令”和“数据方向”这一层：

```text
调用某个读 VI
    -> 构造二进制查询帧
    -> VISA Write
    -> VISA Read
    -> 解析返回帧为温度、电压、电流、频率、功率或状态
```

原始帧中的设备地址、读写标志、数据宽度、符号位、缩放系数、校验和以及是否追加 LF，均标记为待验证。

## 4. Stirling 功能协议表

表中的“命令”是语义命令。Stirling 的原始字节命令尚未从 LabVIEW block diagram 完整反编译出来。

| 语义命令 | 设备 | 方向 | 返回/输入 | 来源 VI | 协议状态 |
| --- | --- | --- | --- | --- | --- |
| `stirling.start` | CT-5221 | 写 | 无或状态响应 | `开机-CT5221.vi` | 语义已确认，帧待验证 |
| `stirling.start_stop` | CT-5505 | 写 | `ON/OFF` 控制输入 | `开关机 - CT5505.vi` | 语义已确认，帧待验证 |
| `stirling.set_voltage` | CT-5505 | 写 | 电压输入，经 `Volt - HEX.vi` 转换 | `设定电压 - CT5505.vi` | 语义已确认，缩放/帧待验证 |
| `stirling.read_cold_head_temperature` | CT-5221 | 读 | 冷头温度 | `冷头温度读取-CT5221.vi` | 语义已确认，单位/缩放待验证 |
| `stirling.read_hot_head_temperature` | CT-5221 / CT-5505 | 读 | 热头温度 | 对应两型号 VI | 语义已确认，单位/缩放待验证 |
| `stirling.read_controller_temperature` | CT-5221 / CT-5505 | 读 | 控制器温度 | 对应两型号 VI | 语义已确认，单位/缩放待验证 |
| `stirling.read_ambient_temperature` | CT-5221 / CT-5505 | 读 | 环境温度 | 对应两型号 VI | 语义已确认，单位/缩放待验证 |
| `stirling.read_motor_temperature` | CT-5221 / CT-5505 | 读 | 电机温度 | 对应两型号 VI | 语义已确认，单位/缩放待验证 |
| `stirling.read_motor_status` | CT-5221 | 读 | 电机状态 | `电机状态读取-CT5221.vi` | 语义已确认，枚举待验证 |
| `stirling.read_output_power` | CT-5221 / CT-5505 | 读 | 输出功率 | 对应两型号 VI | 语义已确认，单位/缩放待验证 |
| `stirling.read_output_current` | CT-5221 / CT-5505 | 读 | 输出电流 | 对应两型号 VI | 语义已确认，单位/缩放待验证 |
| `stirling.read_working_voltage` | CT-5221 / CT-5505 | 读 | 工作电压 | 对应两型号 VI | 语义已确认，单位/缩放待验证 |
| `stirling.read_working_frequency` | CT-5221 / CT-5505 | 读 | 工作频率 | 对应两型号 VI | 语义已确认，单位/缩放待验证 |

## 5. Kelvinion + Stirling 协同控制

### 5.1 控制分工

建议把系统理解成两个不同时间尺度的控制回路：

```text
Stirling 回路：负责基础制冷和设备运行状态
Kelvinion 回路：负责样品温度传感、目标温度、升温速率和加热微调
```

Stirling 的电压或启停动作改变基础制冷能力；Kelvinion 的 setpoint、ramp、range 和 power 改变样品侧的温度调节。两者不是同一个 PID 回路，也不应由 agent 直接交替发送底层命令。

### 5.2 推荐的确定性运行顺序

```text
1. 初始化 Stirling VISA 会话
2. 初始化 Kelvinion VISA/串口会话
3. 读取 Stirling 状态、冷头/热头/控制器/电机温度和电气量
4. 确认 Stirling 已启动并处于允许运行状态
5. 配置 Kelvinion 传感器通道、控制模式、输出范围、ramp 和目标温度
6. 由 Kelvinion 执行升温/稳温，周期性读取两侧状态
7. 只有 Kelvinion 温度满足容差和保持时间，才允许进入 Raman 采集
8. 采集期间继续记录 Kelvinion 温度和 Stirling 诊断量
9. 正常结束时先关闭 Kelvinion 加热输出，再按设备热状态停止 Stirling
```

第 4、7、9 步是协同控制建议，不是当前 VI 已经提供的完整状态机。实际停止顺序需要结合制冷机厂家安全要求和现场热惯性验证。

### 5.3 运行时安全条件

以下条件应作为确定性 runtime 的准入和中止条件：

| 条件 | 处理建议 |
| --- | --- |
| Stirling 无法启动或电机状态异常 | 禁止 Kelvinion 增加加热输出，进入 operator intervention |
| Stirling 控制器、热头或电机温度越限 | 立即关闭 Kelvinion 加热输出，记录 Stirling 诊断，暂停或中止运行 |
| Kelvinion 温度超过硬上限 | 关闭 Kelvinion 输出，保留 Stirling 状态用于诊断 |
| Kelvinion 通信中断 | 不能继续维持未知的加热状态，应执行受控输出关闭并暂停 |
| Raman 采集期间温度离开稳定窗口 | 停止当前采集或暂停 run，不能由 agent 静默改变目标温度 |

这些是控制契约建议，不应在没有设备安全边界和 operator 规则的情况下直接实现为隐含策略。

## 6. 当前代码和资产状态

| 层 | 当前状态 |
| --- | --- |
| Kelvinion Python 驱动 | 已存在，核心命令和控制算法见同目录 Python 文件及协议表 |
| Kelvinion 离线模拟器 | 已存在，可用于基础稳温逻辑测试 |
| Stirling Python 驱动 | 尚未发现 |
| Stirling 离线模拟器 | 尚未发现 |
| Kelvinion + Stirling 联合 runtime action | 尚未接入 `experiment-research` runtime |
| 联合稳定判定和数据记录 | 尚未实现 |
| Stirling 原始二进制协议 | 尚未冻结 |

当前 [raman_runtime_daemon.py](../raman_runtime_daemon.py) 没有温控设备 action；因此这份文档描述的是厂家 VI 能力、协议逆向结果和建议的协同边界，不代表 LabAgent 已经可以执行联合温控实验。

## 7. Stirling 协议冻结前的验证任务

1. 用 LabVIEW 运行每个 CT-5221/CT-5505 读 VI，记录 VISA Write 的原始十六进制帧和 VISA Read 返回帧。
2. 分别记录启动、停止和设定电压的写入帧，确认是否存在校验和、结束字节和重复发送。
3. 用已知温度、电压、电流和频率对照返回值，冻结符号位、缩放系数、单位和字节序。
4. 核对 CT-5221 与 CT-5505 是否共享帧格式，还是只有语义相同。
5. 确认 9600、8N1、LF 终止配置是否为实际设备配置。
6. 先用 fake Stirling runtime 验证联合状态机，再进行显式的现场硬件验证。

在这些任务完成前，不应把推断出的 Stirling 字节帧写入正式 Python driver，也不应让 agent 直接暴露 Stirling 的底层串口操作。
