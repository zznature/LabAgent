# Kelvinion mini temperature controller notes

## Verified bench mapping

- Kelvinion mini serial port: `COM5`
- Default serial configuration: `115200`, `8N1`
- Verified identity response: `[MultiFields Technologies,Kelvinion Mini,1005,V2.1.3b2]`

## Verified commands

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
python docs\Raman\temperature\serial_probe.py --port COM5 --channel A
```

```powershell
python docs\Raman\temperature\serial_protocol_scan.py --port COM5
```
