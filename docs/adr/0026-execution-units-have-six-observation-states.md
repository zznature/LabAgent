# Execution units have six observation states

The MVP frontend observes ExecutionUnits as `pending`, `running`, `waiting_retry`, `succeeded`, `failed`, or `cancelled`. A succeeded unit has an explicit accepted attempt. A failed point remains failed even when mapping continues, while cancelled means the unit will not execute because the run was terminated. The MVP does not add broader workflow-state generality beyond these six states.
