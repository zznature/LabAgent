import type { RamanDomain, RamanVacuumState } from "./schemas/index.ts";

export interface RamanZMotionProfile {
	units: "mm";
	mode: "step";
	voltageV: number;
	frequencyHz: number;
}

export interface RamanEnvironmentRuntimeProfile {
	vacuumState: RamanVacuumState;
	defaultAutofocusMetricName: "labspec_center_spot_focus" | "labspec_no_window_spot_focus";
	zMotionProfile: RamanZMotionProfile;
}

export const DEFAULT_RAMAN_ENVIRONMENT_RUNTIME_PROFILE: RamanEnvironmentRuntimeProfile = {
	vacuumState: "vacuum",
	defaultAutofocusMetricName: "labspec_center_spot_focus",
	zMotionProfile: { units: "mm", mode: "step", voltageV: 50, frequencyHz: 1000 },
};

export const NOT_VACUUM_RAMAN_ENVIRONMENT_RUNTIME_PROFILE: RamanEnvironmentRuntimeProfile = {
	vacuumState: "not_vacuum",
	defaultAutofocusMetricName: "labspec_no_window_spot_focus",
	zMotionProfile: { units: "mm", mode: "step", voltageV: 30, frequencyHz: 1000 },
};

export function resolveRamanEnvironmentRuntimeProfile(raman: RamanDomain): RamanEnvironmentRuntimeProfile {
	const profile = raman.environment?.vacuumState === "not_vacuum"
		? NOT_VACUUM_RAMAN_ENVIRONMENT_RUNTIME_PROFILE
		: DEFAULT_RAMAN_ENVIRONMENT_RUNTIME_PROFILE;
	return {
		...profile,
		zMotionProfile: { ...profile.zMotionProfile },
	};
}
