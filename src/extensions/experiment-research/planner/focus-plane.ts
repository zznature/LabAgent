export interface FocusPlanePoint {
	xUm: number;
	yUm: number;
}

export interface FocusPlaneCorner extends FocusPlanePoint {
	anchorId: "corner_1" | "corner_2" | "corner_3" | "corner_4";
}

export interface FocusPlaneAnchor extends FocusPlanePoint {
	anchorId: string;
	zUm: number;
}

export interface FocusPlaneModel {
	a: number;
	b: number;
	c: number;
	rmsErrorUm: number;
	maxAbsErrorUm: number;
	anchorCount: number;
}

function cross(origin: FocusPlanePoint, a: FocusPlanePoint, b: FocusPlanePoint): number {
	return (a.xUm - origin.xUm) * (b.yUm - origin.yUm) - (a.yUm - origin.yUm) * (b.xUm - origin.xUm);
}

function convexHull<T extends FocusPlanePoint>(points: readonly T[]): T[] {
	const sorted = [...points].sort((left, right) => left.xUm - right.xUm || left.yUm - right.yUm);
	const lower: T[] = [];
	for (const point of sorted) {
		while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) {
			lower.pop();
		}
		lower.push(point);
	}
	const upper: T[] = [];
	for (const point of sorted.reverse()) {
		while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) {
			upper.pop();
		}
		upper.push(point);
	}
	lower.pop();
	upper.pop();
	return lower.concat(upper);
}

export function defaultFocusPlaneCorners(center: FocusPlanePoint): FocusPlaneCorner[] {
	return [
		{ anchorId: "corner_1", xUm: center.xUm - 500, yUm: center.yUm - 500 },
		{ anchorId: "corner_2", xUm: center.xUm + 500, yUm: center.yUm - 500 },
		{ anchorId: "corner_3", xUm: center.xUm + 500, yUm: center.yUm + 500 },
		{ anchorId: "corner_4", xUm: center.xUm - 500, yUm: center.yUm + 500 },
	];
}

export function validateFocusPlaneCorners<T extends FocusPlanePoint>(corners: readonly T[]): T[] {
	if (corners.length !== 4) {
		throw new Error("Focus-plane calibration requires exactly four corners.");
	}
	const uniqueCoordinates = new Set(corners.map((corner) => `${corner.xUm}:${corner.yUm}`));
	if (uniqueCoordinates.size !== 4 || convexHull(corners).length !== 4) {
		throw new Error("Focus-plane corners must form a non-zero convex quadrilateral.");
	}
	return [...corners];
}

export function focusPlaneCenter(corners: readonly FocusPlanePoint[]): FocusPlanePoint {
	validateFocusPlaneCorners(corners);
	return {
		xUm: corners.reduce((sum, corner) => sum + corner.xUm, 0) / corners.length,
		yUm: corners.reduce((sum, corner) => sum + corner.yUm, 0) / corners.length,
	};
}

export function isPointInConvexRegion(point: FocusPlanePoint, region: readonly FocusPlanePoint[]): boolean {
	const hull = convexHull(validateFocusPlaneCorners(region));
	let sign = 0;
	for (let index = 0; index < hull.length; index++) {
		const edgeCross = cross(hull[index]!, hull[(index + 1) % hull.length]!, point);
		if (Math.abs(edgeCross) < 1e-9) {
			continue;
		}
		const edgeSign = Math.sign(edgeCross);
		if (sign !== 0 && edgeSign !== sign) {
			return false;
		}
		sign = edgeSign;
	}
	return true;
}

export function fitFocusPlane(anchors: readonly FocusPlaneAnchor[]): FocusPlaneModel {
	if (anchors.length < 3) {
		throw new Error("At least three focus anchors are required.");
	}
	const xMean = anchors.reduce((sum, anchor) => sum + anchor.xUm, 0) / anchors.length;
	const yMean = anchors.reduce((sum, anchor) => sum + anchor.yUm, 0) / anchors.length;
	const zMean = anchors.reduce((sum, anchor) => sum + anchor.zUm, 0) / anchors.length;
	let xx = 0;
	let xy = 0;
	let yy = 0;
	let xz = 0;
	let yz = 0;
	for (const anchor of anchors) {
		const x = anchor.xUm - xMean;
		const y = anchor.yUm - yMean;
		const z = anchor.zUm - zMean;
		xx += x * x;
		xy += x * y;
		yy += y * y;
		xz += x * z;
		yz += y * z;
	}
	const determinant = xx * yy - xy * xy;
	if (Math.abs(determinant) <= Number.EPSILON * Math.max(xx * yy, 1)) {
		throw new Error("Focus anchors must not be collinear.");
	}
	const a = (xz * yy - yz * xy) / determinant;
	const b = (yz * xx - xz * xy) / determinant;
	const c = zMean - a * xMean - b * yMean;
	const residuals = anchors.map((anchor) => a * anchor.xUm + b * anchor.yUm + c - anchor.zUm);
	return {
		a,
		b,
		c,
		rmsErrorUm: Math.sqrt(residuals.reduce((sum, residual) => sum + residual * residual, 0) / anchors.length),
		maxAbsErrorUm: Math.max(...residuals.map((residual) => Math.abs(residual))),
		anchorCount: anchors.length,
	};
}

export function predictFocusZ(model: Pick<FocusPlaneModel, "a" | "b" | "c">, point: FocusPlanePoint): number {
	return model.a * point.xUm + model.b * point.yUm + model.c;
}
