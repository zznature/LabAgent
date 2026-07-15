const MOTION_COORDINATE_SCALE = 1e9;

export function normalizeMotionCoordinateUm(value: number): number {
	return Math.round(value * MOTION_COORDINATE_SCALE) / MOTION_COORDINATE_SCALE;
}

export function isOutsideMotionRange(value: number, minimum?: number, maximum?: number): boolean {
	return (
		(minimum !== undefined && value < minimum) ||
		(maximum !== undefined && value > maximum)
	);
}
