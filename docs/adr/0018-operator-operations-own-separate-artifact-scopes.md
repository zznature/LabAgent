# Operator operations own separate artifact scopes

Operator frame capture, autofocus, smoke spectrum, and similar actions outside a bounded run receive an `operationId` and store artifacts under `lab-records/operator-operations/<operationId>/`. They never inherit the most recent run or write into its artifact scope. An operation may carry `relatedRunId` for presentation and audit, but only Kernel-owned execution attempts can contribute formal artifacts or an accepted result to a bounded run.
