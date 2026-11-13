# Kelvinion mini temperature controller notes

## Verified bench mapping

- Kelvinion mini serial port: `COM5`
- Default serial configuration: `115200`, `8N1`
- Verified identity response: `[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]`

## Existing bench-verified commands

以下命令来自此前的现场台架记录，不等同于本文件后面的 VI 静态提取结果；两者的
大小写、Mode 值和 Heater 查询命令需要按 Python 驱动实际连接设备再次核对。

- `[*IDN?]`
- `[READ:K:A]`
- `[READ:SETP]`
- `[SET:SETP:<value>]`
- `[READ:RAMP]`
- `[SET:RAMP:<value>]`
- `[READ:RANGE]`
- `[SET:RANGE:<OFF|LOW|MED|HIGH>]`
- `[READ:LOOP]`
- `[SET:LOOP:<A|B>]`
- `[READ:MODE]`
- `[SET:MODE:<A|MA|M>]`
- `[READ:POWER]`
- `[SET:POWER:<value>]`

## Recommended control mode

Real-hardware testing showed `A + LOW + target setpoint` is the reliable heating
baseline. Manual `M + SET:POWER` should only be used for supervised experiments,
because it did not reliably produce the requested ramp during the first 5 K/min
test.

## Probe commands

```powershell
python src\drivers\raman-python\temperature\serial_probe.py --port COM5 --channel A
```

```powershell
python src\drivers\raman-python\temperature\serial_protocol_scan.py --port COM5
```

## VI-derived protocol table

本节是从 `assets/VIs/Kelvinion mini-LabVIEW2015/` 的 47 个 VI，以及根目录的
`Kelvinion mini READ.vi`、`Kelvinion mini Set Temp.vi`、`Kelvinion mini Set Ramp.vi`
静态提取的协议基线。命令大小写按 VI 中的字符串常量记录；设备是否大小写不敏感，
仍需在目标设备上验证。

`<...>` 表示 VI 在 block diagram 中拼接的输入值。`raw/未确认` 表示 VI 中没有找到
足够明确的响应格式字符串，不能仅凭静态提取断言返回类型。

### Transport and framing

| 项目 | VI 证据 | 当前 Python 行为 | 结论 |
| --- | --- | --- | --- |
| API | `VISA Configure Serial Port` | `pyserial.Serial` | 传输层不同，命令层可复用 |
| baud rate | `Kelvinion_Init.vi` 面板标注 `baud rate (9600)` | 默认 `115200` | **待真机核对**；115200 来自当前台架记录，不能由 VI 默认值证明 |
| data bits | 面板标注 `data bits (8)` | `8` | 一致 |
| parity | 面板提供 `None / Odd / Even / Mark / Space`，并标注 `(0:none)` | `NONE` | 当前配置一致 |
| stop bits | 面板标注 `stop bits (10: 1 bit)` | `1` | 一致 |
| read termination | 面板提供 `termination char (0xA = '\\n' = LF)` 与 `Enable Termination Char` | 不依赖 LF；收到 `]` 或达到 response deadline 时结束 | VI 只证明存在可配置 LF 读终止；默认开关状态仍待核对 |
| write termination | 命令字符串常量均以 `]` 结束，未发现附加 CR/LF 常量 | 不追加 CR/LF | 静态证据支持“写入不追加终止符” |
| response framing | 数值格式均以 `[` 开始、部分格式以 `]` 结束 | `_send()` 收到 `]` 即停止，并 `.strip()`；短暂空读不会截断分片响应 | 对已确认的标量/枚举响应基本一致 |

### Read commands

| VI | Command template | Response evidence in VI | Python mapping |
| --- | --- | --- | --- |
| `read IDN.vi` | `[READ:*IDN?]` | raw identity string | `read_identity()`；一致 |
| `read kelvin.vi` / root `READ.vi` | `[READ:K:<channel>]`；root VI 固定 A/B | `[%f]` | `read_temperature_k()`；命令一致，并拒绝当前系统包络 `50 K–350 K` 之外的实测值 |
| `read celsius.vi` | `[READ:C:<channel>]` | raw/未确认 | 未实现 |
| `read current.vi` | `[READ:I:<channel>]` | raw/未确认 | 未接入核心 snapshot；诊断字段返回 unavailable |
| `read voltage.vi` | `[READ:V:<channel>]` | raw/未确认 | 未接入核心 snapshot；诊断字段返回 unavailable |
| `read sensor.vi` | `[READ:S:<channel>]` | raw/未确认 | 未实现 |
| `read sensortype.vi` | `[READ:T:<channel>]` | raw/未确认 | 未实现 |
| `read curve.vi` | `[READ:W:<channel>]` | raw/未确认 | 未实现 |
| `read unit.vi` | `[READ:UNIT:<channel>]` | raw/未确认 | 未实现 |
| `read setpoint.vi` | `[READ:SETP]` | `[%f]` | `read_setpoint_k()`；语义一致 |
| `read Ramp.vi` | `[READ:Ramp]` | `[%f]` | `read_ramp_k_per_min()`；大小写不同 |
| `read Power.vi` | `[READ:Power]` | `[%f]` | `read_heater_power_pct()`；大小写不同 |
| `read Range.vi` | `[READ:Range]` | enum，面板有 `OFF/HIGH/MED/LOW` | `read_output_range()`；值集合一致、大小写不同 |
| `read Loop.vi` | `[READ:Loop]` | raw/未确认 | `read_loop_channel()`；Python 额外接受 `NULL`，VI 面板只显示 `OFF/Loop A/Loop B` |
| `read Heater.vi` | `[READ:Heater]` | `[%d` | 未实现；不是当前 Python 的 heater 电流/电压查询 |
| `read Limit.vi` | `[READ:Limit]` | `[%f]` | 未实现 |
| `read PID.vi` | `[READ:PID]` | `[%f,%f,%f]` | 未实现 |
| `read GPIB.vi` | `[READ:GPIB]` | raw/未确认 | 未实现 |
| `read Filter.vi` | `[READ:F:<...>]` | raw/未确认 | 未实现 |
| `read zone.vi` | `[READ:ZONE]` | raw/未确认 | 未实现 |
| `read Zone parameters.vi` | `[READ:ZONE1]` … `[READ:ZONE5]` | `[%f,%f,%f,%f,%[A-Za-z]]` | 未实现 |
| `read Curve limit.vi` | `[READ:CURVE:LIMIT:<...>]` | `[%f]` | 未实现 |
| `read Relay.vi` | `[READ:RELAY:Point]`, `[READ:RELAY:Cycle]`, `[READ:RELAY:Loop]`, `[READ:RELAY:Limit]` | 使用 `[%f]`、`[%.3f]`、`[%.2f]` 等格式 | 未实现 |

### Set and maintenance commands

| VI | Command template | VI options / response evidence | Python mapping |
| --- | --- | --- | --- |
| root `Set Temp.vi` / `set Temp.vi` | `[SET:SETP:<value>]` | numeric value | `set_setpoint_k()`；命令一致 |
| root `Set Ramp.vi` / `set Ramp.vi` | `[SET:Ramp:<value>]` | numeric value | `set_ramp_k_per_min()`；大小写不同 |
| `set Range.vi` | `[SET:Range:<value>]` | `OFF/HIGH/MED/LOW` | `set_output_range()`；值集合一致、大小写不同 |
| `set Power.vi` | `[SET:Power:<value>]` | numeric value | `set_heater_power_pct()`；大小写不同 |
| `set Loop.vi` | `[SET:Loop:<value>]` | 面板选项 `OFF/Loop A/Loop B` | `set_loop_channel()`；Python 发送 `A/B`，需核对 VI 的枚举到命令值映射 |
| `set Mode.vi` | `[SET:MODE:<value>]` | 面板选项明确为 `PID/Manual` | `set_control_mode()`；Python 当前只接受 `A/MA/M`，**存在协议差异** |
| `set Heater.vi` | `[SET:Heater:<value>]` | numeric/enum value 未完全确认 | 未实现 |
| `set Limit.vi` | `[SET:Limit:<value>]` | numeric value | 未实现 |
| `set PID.vi` | `[SET:PID:<...>]` | PID 参数 | 未实现 |
| `set SensorType.vi` | `[SET:T:<...>]` | 面板区分 Channel A/B | 未实现 |
| `set Curve.vi` | `[SET:W:<...>]` | 面板区分 Channel A/B | 未实现 |
| `set unit.vi` | `[SET:UNIT:<...>]` | unit value | 未实现 |
| `set COMM.vi` | `[SET:COMM:<value>]` | `SERIAL/GPIB` | 未实现 |
| `set GPIB.vi` | `[SET:GPIB:<...>]` | GPIB address/value | 未实现 |
| `set IP.vi` | `[SET:LAN:IP:<...>]` | IP value | 未实现 |
| `set Port.vi` | `[SET:LAN:Port:<...>]` | port value | 未实现 |
| `set Filter.vi` | `[KF:<...>]` | 面板区分 Channel A/B | 未实现 |
| `set Filter On-Off.vi` | `[KF:<...>]` | 面板区分 Channel A/B，开关值未完全确认 | 未实现 |
| `set Zone On-Off.vi` | `[SET:ZONE:<...>]` | `ON/OFF` | 未实现 |
| `set Zone.vi` | `[SET:ZONE<zone>:Range:<range>]`（由多个字符串拼接推断） | Zone1–Zone5，range 有 `OFF` 等选项 | 未实现 |
| `set Relay.vi` | `[SET:RELAY:<...>]` | Loop/Limit 等字段，由输入拼接 | 未实现 |
| `Save.vi` | `[SET:SAVE]` | 无数据响应格式证据 | 未实现 |
| `Recovery.vi` | `[SET:Recovery]` | 无数据响应格式证据 | 未实现 |

`未命名 1.vi` 是把上述子 VI 汇总成一个调用面板的容器，不增加新的设备命令。

## Python driver audit

当前 [kelvinion_mini_controller.py](./kelvinion_mini_controller.py) 已覆盖核心的温度设定路径：IDN、K 通道温度、setpoint、ramp、power、range 和 loop。静态 VI 对照得到以下必须在真机上确认的项目：

1. **串口速率**：VI 面板标注 9600，当前台架记录和 Python 默认值为 115200；两者不能同时作为已确认事实。
2. **Mode**：VI 面板值为 `PID/Manual`，Python 类型为 `A/MA/M`。在修改驱动前需要抓取实际写出的字符串，确认面板显示值是否经过映射。
3. **Heater 电流/电压**：VI 提供 `[READ:Heater]`、`[READ:I:<channel>]`、`[READ:V:<channel>]`；核心 snapshot 已停止发送没有厂家 VI 证据的 `[READ:HEATER:I]` 和 `[READ:HEATER:V]`，对应诊断字段暂为 unavailable。
4. **大小写**：VI 同时使用 `READ:Power`、`READ:Ramp`、`SET:Range` 等混合大小写，Python 将它们全部大写。设备大小写不敏感尚无静态证明。
5. **响应类型**：Python 当前标量解析器只接受 `[number]`，枚举解析器只接受 `[letters]`；厂家协议还包含 PID/Zone/Relay 的逗号结构和 raw 字符串，扩展功能时不能复用错误的解析器。
6. **终止符**：VI 的命令常量没有附加 CR/LF；`Kelvinion_Init.vi` 的 LF 终止配置应理解为 VISA 读侧设置，默认是否启用仍需硬件或 VI 运行时确认。

离线 transcript 回归测试位于 `temperature/test_kelvinion_mini_controller.py`，覆盖核心 snapshot、分片与延迟响应、空响应、噪声、畸形响应、串口 I/O 异常、遗留输入清理和台架已验证命令帧。测试通过注入的 serial adapter 运行，不连接 COM 端口，并由仓库根目录 `./test.sh` 默认执行。

当前 Python driver 还没有把 `50 K–350 K` 解释为允许 target 范围、warning/abort 阈值或 guard band；这些仍需设备资料和实验负责人确认。

本表是静态提取基线，不把尚未在目标 Kelvinion 设备上验证的字段标记为“已支持”。
