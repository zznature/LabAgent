# LabAgents

LabAgents is the Raman lab product layer for pi. The pi runtime is consumed as a
fixed npm dependency; this repository owns the product source (`src/`), the
deployment layer (`deploy/`), design notes, and product tests. See
`docs/repo-structure.md` for the full layout.

## Install

```sh
npm install --ignore-scripts
npm run check
npm test
```

## Setup a Lab Workspace

The agent must run from a workspace that does not contain product source code.

```sh
deploy/setup-workspace.sh /path/to/RamanLabWorkspace
```

On a Windows lab machine, run the PowerShell script from the LabAgents product
repo:

```powershell
.\deploy\setup-workspace.ps1 C:\RamanLab\RamanLabWorkspace
```

The setup script creates `.pi/settings.json`, `.pi/labagents-policy.json`, the
`lab-config/` configuration directory (runtime configs, user prompts, and the
deployed Raman Python driver copy), and the `lab-records/` output directory.
It does not overwrite `lab-config/raman-runtime.local.json` or
`lab-config/user-prompts.md`; re-running it refreshes the driver copy.

For live Raman hardware, install the deployed Python driver dependencies on the
lab machine into a workspace-local virtual environment:

```powershell
py -3.12 -m venv C:\RamanLab\RamanLabWorkspace\.venv
C:\RamanLab\RamanLabWorkspace\.venv\Scripts\python.exe -m pip install -r C:\RamanLab\RamanLabWorkspace\lab-config\drivers\raman-python\requirements.txt
```

Use that workspace-local Python executable in
`lab-config\raman-runtime.local.json` as `pythonExecutable`. The lab template
defaults to `C:\RamanLab\RamanLabWorkspace\.venv\Scripts\python.exe` after
rendering. The local runtime config is merged over `raman-runtime.lab.json`, so
it can contain only local differences such as `pythonExecutable` and
`stage.config.port`.

The MC.Newton LT-06 vendor SDK wheel is bundled under
`lab-config\drivers\raman-python\vendor\` and is loaded directly by the stage
driver if it has not been installed into the Python environment. Installing it
separately is optional unless the lab wants the SDK available outside
LabAgents.

To refresh only the deployed Raman Python driver copy without rewriting `.pi`
settings or lab runtime config, run:

```powershell
.\deploy\sync-driver.ps1 C:\RamanLab\RamanLabWorkspace
```

## Run

```sh
deploy/run-labagents.sh /path/to/RamanLabWorkspace
```

On Windows:

```powershell
.\deploy\run-labagents.ps1 C:\RamanLab\RamanLabWorkspace
```

The run script launches the locally installed, pinned `pi` binary from this
repository and changes cwd to the lab workspace before starting the agent.
