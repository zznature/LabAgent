import { describe, expect, it } from "vitest";
import type { ProcedureSpec } from "../schemas/index.ts";
import { validateProcedureSpecTool } from "../tools/planner.ts";

const noWindowMetricSpec: ProcedureSpec = {
	procedureSpecId: "procedure-no-window-focus",
	experimentId: "experiment-no-window-focus",
	intentId: "intent-no-window-focus",
	procedureId: "raman_single_point_probe",
	procedureVersion: "0.1.0",
	resources: [
		{ resourceId: "stage-main", role: "stage" },
		{ resourceId: "frame-main", role: "frame_provider" },
		{ resourceId: "spectrometer-main", role: "spectrometer" },
	],
	limits: {
		maxLaserPowerPercent: 1,
		minObjectiveClearanceUm: 200,
	},
	plan: {
		kind: "current_position",
		perPoint: [{ kind: "autofocus" }],
	},
	stoppingRules: {
		maxRuntimeMinutes: 10,
		maxUnits: 1,
		stopOnError: true,
	},
	domain: {
		raman: {
			autofocus: {
				enabled: true,
				roi: { x: 492, y: 353, width: 225, height: 225 },
				params: {
					zStartUm: 1450,
					zEndUm: 1550,
					pointCount: 10,
					metricName: "labspec_no_window_spot_focus",
				},
			},
			acquisition: {
				integrationTimeMs: 1000,
				laserPowerPercent: 0.1,
				accumulations: 1,
			},
		},
	},
};

describe("Raman autofocus metric selection", () => {
	it("accepts the no-window spot metric in a bounded ProcedureSpec", async () => {
		const result = await validateProcedureSpecTool.execute(
			"validate-no-window-metric",
			{ spec: noWindowMetricSpec },
		);

		expect(result.details.status).toBe("success");
		expect(result.details.stateAfter.valid).toBe(true);
	});
});
