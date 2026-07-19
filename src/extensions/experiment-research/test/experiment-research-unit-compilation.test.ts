import { describe, expect, it } from "vitest";
import { compileProcedureSpec } from "../kernel/compile-units.ts";
import { ExecutionUnitValidator } from "../schemas/execution-unit.ts";
import type { ProcedureSpec } from "../schemas/procedure-spec.ts";

function createBaseProcedureSpec() {
	return {
		procedureSpecId: "proc-spec-compile",
		experimentId: "exp-compile",
		intentId: "intent-compile",
		procedureId: "raman_grid_mapping",
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
		stoppingRules: {
			maxRuntimeMinutes: 30,
			maxUnits: 16,
			stopOnError: true,
		},
		domain: {
			raman: {
				autofocus: {
					enabled: true,
					roi: { x: 100, y: 100, width: 64, height: 64 },
				},
				acquisition: {
					integrationTimeMs: 1000,
					laserPowerPercent: 0.1,
					accumulations: 1,
				},
			},
		},
		plan: {
			kind: "grid_scan",
			grid: {
				origin: { xUm: 1000, yUm: 2000, zUm: 50 },
				rows: 2,
				cols: 3,
				pitchXUm: 5,
				pitchYUm: 10,
				order: "snake",
			},
			perPoint: [
				{ kind: "move_to_point" },
				{ kind: "autofocus" },
				{ kind: "capture_frame" },
				{ kind: "acquire_spectrum" },
			],
			interPointDelayMs: 1_000,
		},
	};
}

describe("experiment research unit compilation", () => {
	it("compiles point_list plans into one point unit per point", () => {
		const spec = {
			...createBaseProcedureSpec(),
			procedureId: "raman_single_point_probe",
			plan: {
				kind: "point_list",
				points: [
					{ xUm: 1000, yUm: 2000 },
					{ xUm: 1005, yUm: 2010, zUm: 50 },
				],
				interPointDelayMs: 300_000,
				perPoint: [{ kind: "move_to_point" }, { kind: "autofocus" }, { kind: "acquire_spectrum" }],
			},
		};

		const units = compileProcedureSpec(spec as ProcedureSpec);

		expect(units).toHaveLength(2);
		expect(units[0]?.point).toEqual({ row: undefined, col: undefined, xUm: 1000, yUm: 2000, zUm: undefined });
		expect(units[1]?.point).toEqual({ row: undefined, col: undefined, xUm: 1005, yUm: 2010, zUm: 50 });
		expect(units[0]?.interUnitDelayMs).toBe(300_000);
		expect(units[1]?.interUnitDelayMs).toBeUndefined();
		expect(units[0]?.limits).toEqual(spec.limits);
		expect(units[0]?.actions).toEqual(spec.plan.perPoint);
		expect(units.every((unit) => ExecutionUnitValidator.Check(unit))).toBe(true);
	});

	it("compiles current_position plans into one current-position unit without absolute coordinates", () => {
		const spec = {
			...createBaseProcedureSpec(),
			procedureId: "raman_single_point_probe",
			plan: {
				kind: "current_position",
				perPoint: [{ kind: "move_to_point" }, { kind: "autofocus" }, { kind: "acquire_spectrum" }],
			},
		};

		const units = compileProcedureSpec(spec as ProcedureSpec);

		expect(units).toHaveLength(1);
		expect(units[0]?.positionRef).toBe("current");
		expect(units[0]?.point).toBeUndefined();
		expect(units[0]?.actions).toEqual(spec.plan.perPoint);
		expect(units.every((unit) => ExecutionUnitValidator.Check(unit))).toBe(true);
	});

	it("compiles grid_scan plans into stable snake-ordered point units", () => {
		const spec = createBaseProcedureSpec();

		const units = compileProcedureSpec(spec as ProcedureSpec);

		expect(units).toHaveLength(6);
		expect(units.map((unit) => unit.unitId)).toEqual([
			"proc-spec-compile:unit:0000",
			"proc-spec-compile:unit:0001",
			"proc-spec-compile:unit:0002",
			"proc-spec-compile:unit:0003",
			"proc-spec-compile:unit:0004",
			"proc-spec-compile:unit:0005",
		]);
		expect(units.map((unit) => unit.resumeKey)).toEqual([
			"proc-spec-compile/unit/0000",
			"proc-spec-compile/unit/0001",
			"proc-spec-compile/unit/0002",
			"proc-spec-compile/unit/0003",
			"proc-spec-compile/unit/0004",
			"proc-spec-compile/unit/0005",
		]);
		expect(units.map((unit) => unit.point)).toEqual([
			{ row: 0, col: 0, xUm: 1000, yUm: 2000, zUm: 50 },
			{ row: 0, col: 1, xUm: 1005, yUm: 2000, zUm: 50 },
			{ row: 0, col: 2, xUm: 1010, yUm: 2000, zUm: 50 },
			{ row: 1, col: 2, xUm: 1010, yUm: 2010, zUm: 50 },
			{ row: 1, col: 1, xUm: 1005, yUm: 2010, zUm: 50 },
			{ row: 1, col: 0, xUm: 1000, yUm: 2010, zUm: 50 },
		]);
		expect(units.every((unit) => unit.unitKind === "point")).toBe(true);
		expect(units.slice(0, -1).every((unit) => unit.interUnitDelayMs === 1_000)).toBe(true);
		expect(units.at(-1)?.interUnitDelayMs).toBeUndefined();
		expect(units.every((unit) => unit.artifactScope.artifactPathPrefix.includes("proc-spec-compile"))).toBe(true);
		expect(units.every((unit) => ExecutionUnitValidator.Check(unit))).toBe(true);
	});
});
