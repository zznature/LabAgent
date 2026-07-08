import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactRef } from "../../schemas/tool-result.ts";
import {
	failedActionResult,
	successActionResult,
	type ActionError,
	type ActionResult,
	type AutofocusRunSingleAction,
	type FrameCaptureLatestAction,
	type SpectrometerAcquireSpectrumAction,
	type StageGetPositionAction,
	type StageMoveAbsoluteAndWaitAction,
} from "./actions.ts";
import { registerRamanLiveRuntime, clearRamanLiveRuntime, type RamanLivePreflightResult, type RamanLiveRuntime } from "./live-runtime.ts";
import {
	FrameProviderResourceValidator,
	SpectrometerResourceValidator,
	StageResourceValidator,
	type FrameProviderResource,
	type SpectrometerResource,
	type StageResource,
} from "./resources.ts";

export const RAMAN_PYTHON_RUNTIME_LOCAL_CONFIG_PATH = join("lab-config", "raman-runtime.local.json");
export const RAMAN_PYTHON_RUNTIME_LAB_CONFIG_PATH = join("lab-config", "raman-runtime.lab.json");
export const RAMAN_HARDWARE_PYTHON_DRIVER_PATH = join("lab-config", "drivers", "raman-python");
export const RAMAN_RUNTIME_DAEMON_SCRIPT = "raman_runtime_daemon.py";

const DEFAULT_DAEMON_IDLE_SHUTDOWN_MS = 30_000;
const DAEMON_GRACEFUL_KILL_MS = 2_000;

export type RamanPythonRuntimeConfigSource = "local" | "lab" | "none";

export interface RamanPythonRuntimeConfigInfo {
	source: RamanPythonRuntimeConfigSource;
	path?: string;
	enabled: boolean;
	resources?: {
		stage: {
			resourceId: string;
			driver: string;
			port: string;
			limits: StageResource["limits"];
		};
		frameProvider: {
			resourceId: string;
			driver: string;
			bridgeDir: string;
		};
		spectrometer: {
			resourceId: string;
			driver: string;
			bridgeDir: string;
			laserPower?: SpectrometerResource["config"]["laserPower"];
		};
	};
}

export interface RamanPythonRuntimeConfig {
	enabled: boolean;
	pythonExecutable?: string;
	pythonRoot?: string;
	stage: StageResource;
	frameProvider: FrameProviderResource;
	spectrometer: SpectrometerResource;
	preflight?: {
		requirePythonRoot?: boolean;
		requireBridgeDirs?: boolean;
		connectStage?: boolean;
	};
	spectrum?: {
		outputDir?: string;
		saturationIntensity?: number;
		targetPeakMinWavenumber?: number;
		targetPeakMaxWavenumber?: number;
	};
	daemon?: {
		idleShutdownMs?: number;
	};
}

interface RamanPythonRuntimeConfigCandidate {
	source: Exclude<RamanPythonRuntimeConfigSource, "none">;
	path: string;
}

interface LoadedRamanPythonRuntimeConfig {
	source: Exclude<RamanPythonRuntimeConfigSource, "none">;
	path: string;
	config: RamanPythonRuntimeConfig;
}

type PythonActionKind = "preflight" | "stage_position" | "stage_move" | "frame_capture" | "autofocus" | "spectrum";

interface PythonRequestEnvelope {
	requestId: string;
	action: PythonActionKind;
	pythonRoot: string;
	stage: StageResource;
	frameProvider: FrameProviderResource;
	spectrometer: SpectrometerResource;
	payload: Record<string, unknown>;
}

interface PythonSuccess {
	ok: true;
	summary: string;
	payload: Record<string, unknown>;
}

interface PythonFailure {
	ok: false;
	errorCode: string;
	message: string;
	retrySafe: boolean;
	needsOperator: boolean;
	safeToResume: boolean;
	payload?: Record<string, unknown>;
}

type PythonResponse = PythonSuccess | PythonFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function asArtifact(path: unknown, kind: string, label: string): ArtifactRef[] {
	if (typeof path !== "string" || path.length === 0) {
		return [];
	}
	return [
		{
			artifactId: `${kind}-${randomUUID().slice(0, 8)}`,
			kind,
			path: path.replace(/\\/gu, "/"),
			label,
		},
	];
}

function toActionFailure(response: PythonFailure): ActionResult {
	const error: ActionError = {
		errorCode: response.errorCode,
		message: response.message,
		retrySafe: response.retrySafe,
		needsOperator: response.needsOperator,
		safeToResume: response.safeToResume,
	};
	return failedActionResult(response.message, error, response.payload ?? {});
}

function toPythonResponse(parsed: unknown): PythonResponse {
	if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
		throw new Error("Python Raman runtime returned an invalid response shape.");
	}
	if (parsed.ok) {
		return {
			ok: true,
			summary: readString(parsed, "summary") ?? "Python Raman action completed.",
			payload: isRecord(parsed.payload) ? parsed.payload : {},
		};
	}
	return {
		ok: false,
		errorCode: readString(parsed, "errorCode") ?? "python_runtime_error",
		message: readString(parsed, "message") ?? "Python Raman action failed.",
		retrySafe: readBoolean(parsed, "retrySafe") ?? false,
		needsOperator: readBoolean(parsed, "needsOperator") ?? true,
		safeToResume: readBoolean(parsed, "safeToResume") ?? false,
		payload: isRecord(parsed.payload) ? parsed.payload : {},
	};
}

interface PendingRequest {
	requestId: string;
	settle: (response: PythonResponse) => void;
}

export interface RamanPythonDaemonOptions {
	command: string;
	scriptPath: string;
	cwd: string;
	pythonRoot: string;
	stage: StageResource;
	frameProvider: FrameProviderResource;
	spectrometer: SpectrometerResource;
	idleShutdownMs: number;
}

/**
 * Persistent client for the Python Raman hardware daemon.
 *
 * The daemon is spawned lazily on the first action and kept alive so a
 * multi-point mapping run connects to hardware once instead of reconnecting on
 * every action. Requests are serialized so the single hardware session is never
 * touched concurrently (operator tools and the active run share one daemon).
 * A timed-out action kills and resets the daemon; the next action respawns it.
 */
export class RamanPythonDaemon {
	private readonly options: RamanPythonDaemonOptions;
	private child: ChildProcessWithoutNullStreams | undefined;
	private stdoutBuffer = "";
	private pending: PendingRequest | undefined;
	private queue: Promise<PythonResponse | void> = Promise.resolve();
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: RamanPythonDaemonOptions) {
		this.options = options;
	}

	request(action: PythonActionKind, payload: Record<string, unknown>, timeoutMs: number): Promise<PythonResponse> {
		const result = this.queue.then(
			() => this.sendOne(action, payload, timeoutMs),
			() => this.sendOne(action, payload, timeoutMs),
		);
		this.queue = result.catch(() => undefined);
		return result;
	}

	shutdown(): void {
		this.clearIdleTimer();
		const child = this.child;
		if (!child) {
			return;
		}
		this.detachChild();
		this.settlePending({
			ok: false,
			errorCode: "python_runtime_closed",
			message: "Python Raman daemon was shut down before the action completed.",
			retrySafe: true,
			needsOperator: false,
			safeToResume: true,
		});
		try {
			child.stdin.end();
		} catch {
			// stdin may already be closed.
		}
		const killTimer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// process may already have exited.
			}
		}, DAEMON_GRACEFUL_KILL_MS);
		killTimer.unref();
		child.once("close", () => clearTimeout(killTimer));
	}

	private sendOne(action: PythonActionKind, payload: Record<string, unknown>, timeoutMs: number): Promise<PythonResponse> {
		return new Promise<PythonResponse>((resolveResult) => {
			this.clearIdleTimer();
			let child: ChildProcessWithoutNullStreams;
			try {
				child = this.ensureChild();
			} catch (cause) {
				resolveResult({
					ok: false,
					errorCode: "python_runtime_spawn_failed",
					message: cause instanceof Error ? cause.message : String(cause),
					retrySafe: false,
					needsOperator: true,
					safeToResume: false,
				});
				return;
			}

			const requestId = randomUUID();
			let done = false;
			const timer = setTimeout(() => {
				if (done) {
					return;
				}
				done = true;
				this.pending = undefined;
				this.killChild();
				resolveResult({
					ok: false,
					errorCode: "python_runtime_timeout",
					message: `Python Raman action ${action} timed out after ${timeoutMs} ms.`,
					retrySafe: false,
					needsOperator: true,
					safeToResume: false,
				});
			}, timeoutMs);

			this.pending = {
				requestId,
				settle: (response) => {
					if (done) {
						return;
					}
					done = true;
					clearTimeout(timer);
					this.scheduleIdleShutdown();
					resolveResult(response);
				},
			};

			const envelope: PythonRequestEnvelope = {
				requestId,
				action,
				pythonRoot: this.options.pythonRoot,
				stage: this.options.stage,
				frameProvider: this.options.frameProvider,
				spectrometer: this.options.spectrometer,
				payload,
			};
			try {
				child.stdin.write(`${JSON.stringify(envelope)}\n`);
			} catch {
				// The close/error handlers settle the pending request when the daemon is gone.
			}
		});
	}

	private ensureChild(): ChildProcessWithoutNullStreams {
		if (this.child) {
			return this.child;
		}
		const child = spawn(this.options.command, [this.options.scriptPath], {
			cwd: this.options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => this.onStdout(child, chunk));
		child.stderr.resume();
		child.stdin.on("error", () => {
			// A daemon that exits early surfaces through the close handler; ignore EPIPE on stdin.
		});
		child.on("error", (cause) => this.onChildGone(child, "python_runtime_spawn_failed", cause.message));
		child.on("close", (code) => this.onChildGone(child, "python_runtime_exit_failed", `Python Raman daemon exited with code ${code}.`));
		this.child = child;
		this.stdoutBuffer = "";
		return child;
	}

	private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
		if (child !== this.child) {
			return;
		}
		this.stdoutBuffer += chunk;
		let newlineIndex = this.stdoutBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line.length > 0) {
				this.consumeLine(line);
			}
			newlineIndex = this.stdoutBuffer.indexOf("\n");
		}
	}

	private consumeLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		const pending = this.pending;
		if (!pending || !isRecord(parsed) || parsed.requestId !== pending.requestId) {
			return;
		}
		this.pending = undefined;
		try {
			pending.settle(toPythonResponse(parsed));
		} catch (cause) {
			pending.settle({
				ok: false,
				errorCode: "python_runtime_parse_failed",
				message: cause instanceof Error ? cause.message : String(cause),
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
			});
		}
	}

	private onChildGone(child: ChildProcessWithoutNullStreams, errorCode: string, message: string): void {
		if (child !== this.child) {
			return;
		}
		this.detachChild();
		this.settlePending({
			ok: false,
			errorCode,
			message,
			retrySafe: false,
			needsOperator: true,
			safeToResume: false,
		});
	}

	private settlePending(response: PythonResponse): void {
		const pending = this.pending;
		if (!pending) {
			return;
		}
		this.pending = undefined;
		pending.settle(response);
	}

	private killChild(): void {
		const child = this.child;
		this.detachChild();
		if (child) {
			try {
				child.kill();
			} catch {
				// process may already have exited.
			}
		}
	}

	private detachChild(): void {
		this.child = undefined;
		this.stdoutBuffer = "";
	}

	private scheduleIdleShutdown(): void {
		this.clearIdleTimer();
		if (!this.child || this.options.idleShutdownMs <= 0) {
			return;
		}
		this.idleTimer = setTimeout(() => this.shutdown(), this.options.idleShutdownMs);
		this.idleTimer.unref();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}
}

const daemonRegistry = new Map<string, RamanPythonDaemon>();

function registerDaemon(cwd: string, daemon: RamanPythonDaemon): void {
	daemonRegistry.get(cwd)?.shutdown();
	daemonRegistry.set(cwd, daemon);
}

export function shutdownRamanPythonDaemon(cwd: string): void {
	daemonRegistry.get(cwd)?.shutdown();
	daemonRegistry.delete(cwd);
}

function configCandidates(cwd: string): RamanPythonRuntimeConfigCandidate[] {
	return [
		{
			source: "local",
			path: join(cwd, RAMAN_PYTHON_RUNTIME_LOCAL_CONFIG_PATH),
		},
		{
			source: "lab",
			path: join(cwd, RAMAN_PYTHON_RUNTIME_LAB_CONFIG_PATH),
		},
	];
}

function readConfigFile(path: string): RamanPythonRuntimeConfig {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") {
		throw new Error(`Invalid Raman Python runtime config at ${path}: enabled must be boolean.`);
	}
	if (
		parsed.enabled &&
		(!StageResourceValidator.Check(parsed.stage) ||
			!FrameProviderResourceValidator.Check(parsed.frameProvider) ||
			!SpectrometerResourceValidator.Check(parsed.spectrometer))
	) {
		throw new Error(`Invalid Raman Python runtime config at ${path}: enabled config requires valid stage, frameProvider, and spectrometer resources.`);
	}
	return parsed as unknown as RamanPythonRuntimeConfig;
}

function readConfig(cwd: string): LoadedRamanPythonRuntimeConfig | undefined {
	for (const candidate of configCandidates(cwd)) {
		const path = candidate.path;
		if (!existsSync(path)) {
			continue;
		}
		return {
			source: candidate.source,
			path,
			config: readConfigFile(path),
		};
	}
	return undefined;
}

export function getRamanPythonRuntimeConfigInfo(cwd: string): RamanPythonRuntimeConfigInfo {
	const loaded = readConfig(cwd);
	if (!loaded) {
		return {
			source: "none",
			enabled: false,
		};
	}
	const { config } = loaded;
	if (!config.enabled) {
		return {
			source: loaded.source,
			path: loaded.path,
			enabled: false,
		};
	}
	return {
		source: loaded.source,
		path: loaded.path,
		enabled: config.enabled,
		resources: {
			stage: {
				resourceId: config.stage.resourceId,
				driver: config.stage.driver,
				port: config.stage.config.port,
				limits: config.stage.limits,
			},
			frameProvider: {
				resourceId: config.frameProvider.resourceId,
				driver: config.frameProvider.driver,
				bridgeDir: config.frameProvider.config.bridgeDir,
			},
			spectrometer: {
				resourceId: config.spectrometer.resourceId,
				driver: config.spectrometer.driver,
				bridgeDir: config.spectrometer.config.bridgeDir,
				laserPower: config.spectrometer.config.laserPower,
			},
		},
	};
}

function createActionResult(response: PythonResponse, artifacts: ArtifactRef[] = []): ActionResult {
	if (!response.ok) {
		return toActionFailure(response);
	}
	return successActionResult(response.summary, response.payload, artifacts);
}

export function createRamanPythonRuntime(cwd: string, config: RamanPythonRuntimeConfig): RamanLiveRuntime {
	const pythonRoot = resolve(cwd, config.pythonRoot ?? RAMAN_HARDWARE_PYTHON_DRIVER_PATH);
	const resolvedConfig: RamanPythonRuntimeConfig = { ...config, pythonRoot };
	const daemon = new RamanPythonDaemon({
		command: resolvedConfig.pythonExecutable ?? "python",
		scriptPath: join(pythonRoot, RAMAN_RUNTIME_DAEMON_SCRIPT),
		cwd,
		pythonRoot,
		stage: resolvedConfig.stage,
		frameProvider: resolvedConfig.frameProvider,
		spectrometer: resolvedConfig.spectrometer,
		idleShutdownMs: resolvedConfig.daemon?.idleShutdownMs ?? DEFAULT_DAEMON_IDLE_SHUTDOWN_MS,
	});
	registerDaemon(cwd, daemon);

	return {
		preflight: async (): Promise<RamanLivePreflightResult> => {
			const response = await daemon.request(
				"preflight",
				{
					requirePythonRoot: resolvedConfig.preflight?.requirePythonRoot ?? true,
					requireBridgeDirs: resolvedConfig.preflight?.requireBridgeDirs ?? false,
					connectStage: resolvedConfig.preflight?.connectStage ?? false,
				},
				30_000,
			);
			return {
				preflightReady: response.ok,
				controlAvailable: response.ok,
				details: response.ok ? response.payload : { errorCode: response.errorCode, message: response.message },
			};
		},
		stage: {
			resource: resolvedConfig.stage,
			getPosition: async (action: StageGetPositionAction): Promise<ActionResult> =>
				createActionResult(await daemon.request("stage_position", { timeoutMs: action.timeoutMs }, action.timeoutMs + 10_000)),
			moveAbsoluteAndWait: async (action: StageMoveAbsoluteAndWaitAction): Promise<ActionResult> =>
				createActionResult(
					await daemon.request("stage_move", { target: action.target, timeoutMs: action.timeoutMs }, action.timeoutMs + 10_000),
				),
		},
		autofocus: {
			runSingle: async (action: AutofocusRunSingleAction): Promise<ActionResult> =>
				createActionResult(
					await daemon.request(
						"autofocus",
						{ roi: action.roi, params: action.params, timeoutMs: action.timeoutMs },
						action.timeoutMs + 10_000,
					),
				),
		},
		frame: {
			resource: resolvedConfig.frameProvider,
			captureLatest: async (action: FrameCaptureLatestAction): Promise<ActionResult> => {
				const response = await daemon.request("frame_capture", { timeoutMs: action.timeoutMs }, action.timeoutMs + 10_000);
				return createActionResult(response, response.ok ? asArtifact(response.payload.framePath, "frame", "LabSpec frame") : []);
			},
		},
		spectrometer: {
			resource: resolvedConfig.spectrometer,
			acquireSpectrum: async (action: SpectrometerAcquireSpectrumAction): Promise<ActionResult> => {
				const pointId = `point-${randomUUID().slice(0, 8)}`;
				const response = await daemon.request(
					"spectrum",
					{
						pointId,
						acquisition: action.acquisition,
						timeoutMs: action.timeoutMs,
						outputDir: resolvedConfig.spectrum?.outputDir,
						saturationIntensity: resolvedConfig.spectrum?.saturationIntensity,
						targetPeakMinWavenumber: resolvedConfig.spectrum?.targetPeakMinWavenumber,
						targetPeakMaxWavenumber: resolvedConfig.spectrum?.targetPeakMaxWavenumber,
					},
					action.timeoutMs + 10_000,
				);
				const artifacts = response.ok
					? [
							...asArtifact(response.payload.outputPath, "spectrum", "LabSpec spectrum"),
							...asArtifact(response.payload.spectrumPlotPath, "spectrum-plot", "LabSpec spectrum plot"),
						]
					: [];
				return createActionResult(response, artifacts);
			},
		},
	};
}

export function registerConfiguredRamanPythonRuntime(cwd: string): boolean {
	const loaded = readConfig(cwd);
	if (!loaded) {
		return false;
	}
	const { config } = loaded;
	if (!config.enabled) {
		clearRamanLiveRuntime(cwd);
		shutdownRamanPythonDaemon(cwd);
		return false;
	}
	registerRamanLiveRuntime(cwd, createRamanPythonRuntime(cwd, config));
	return true;
}
