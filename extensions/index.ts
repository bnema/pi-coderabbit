import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";

const TOOL_NAME = "coderabbit_review";
const TOOL_LABEL = "CodeRabbit Review";
const MESSAGE_TYPE = "pi-coderabbit-review";
const STATUS_KEY = "pi-coderabbit";
const WIDGET_KEY = "pi-coderabbit";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_MODE_ARGS = new Set(["--agent", "--plain", "--interactive"]);
const KNOWN_PHASES = ["connecting", "setup", "analyzing", "reviewing", "complete"];

const ReviewParamsSchema = Type.Object({
	args: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Extra CodeRabbit CLI arguments. The extension always forces --agent for JSONL output.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Maximum review runtime in milliseconds. Defaults to PI_CODERABBIT_TIMEOUT_MS or 600000.",
			minimum: 1000,
			maximum: 60 * 60 * 1000,
		}),
	),
});

type ReviewParams = Static<typeof ReviewParamsSchema>;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

interface JsonObject {
	[key: string]: JsonValue;
}

interface StatusEntry {
	phase: string;
	status: string;
	timestamp: number;
}

interface ReviewState {
	id: string;
	cwd: string;
	command: string;
	args: string[];
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	exitSignal?: string | null;
	timedOut: boolean;
	aborted: boolean;
	statuses: StatusEntry[];
	jsonEvents: JsonObject[];
	reviewEvents: JsonObject[];
	findings: CodeRabbitFinding[];
	errorEvents: JsonObject[];
	reviewContext?: JsonObject;
	plainStdoutLines: string[];
	stderrLines: string[];
	outputFile?: string;
}

interface CodeRabbitFinding {
	severity: string;
	fileName: string;
	codegenInstructions: string;
	suggestions: string[];
	raw: JsonObject;
}

interface SeverityCounts {
	[severity: string]: number;
}

interface ReviewSnapshot {
	id: string;
	cwd: string;
	command: string;
	args: string[];
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	exitSignal?: string | null;
	timedOut: boolean;
	aborted: boolean;
	statuses: StatusEntry[];
	currentPhase?: string;
	currentStatus?: string;
	jsonEventCount: number;
	reviewEventCount: number;
	findingCount: number;
	errorEventCount: number;
	severityCounts: SeverityCounts;
	plainStdoutLineCount: number;
	stderrLineCount: number;
	outputFile?: string;
}

interface ReviewResult {
	success: boolean;
	snapshot: ReviewSnapshot;
	summary: string;
	output: string;
	outputFile?: string;
}

interface CodeRabbitToolDetails {
	kind: "pi-coderabbit";
	inProgress: boolean;
	success?: boolean;
	snapshot: ReviewSnapshot;
	summary?: string;
}

interface ProcessExit {
	code: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
}

type ToolUpdate = (update: {
	content: Array<{ type: "text"; text: string }>;
	details: CodeRabbitToolDetails;
}) => void;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(event: JsonObject, key: string): string | undefined {
	const value = event[key];
	return typeof value === "string" ? value : undefined;
}

function parseJsonLine(line: string): JsonObject | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isStatusEvent(event: JsonObject): boolean {
	return stringField(event, "type") === "status";
}

function humanize(value: string | undefined): string {
	if (!value) return "unknown";
	const text = value.replace(/[_-]+/g, " ").trim();
	return text ? text[0]!.toUpperCase() + text.slice(1) : "unknown";
}

function quoteArg(value: string): string {
	if (/^[a-zA-Z0-9_./:=+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCommand(command: string, args: string[]): string {
	return [command, ...args].map(quoteArg).join(" ");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 100) / 10;
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.round(seconds % 60);
	return `${minutes}m ${remainder}s`;
}

function parseCliArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			escaping = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaping) current += "\\";
	if (current) args.push(current);
	return args;
}

function envFlagEnabled(name: string, defaultValue: boolean): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (!value) return defaultValue;
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envNumber(name: string, defaultValue: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function commandCandidates(): string[] {
	const configured = process.env.PI_CODERABBIT_BIN?.trim();
	if (configured) return [configured];
	return ["coderabbit", "cr"];
}

function normalizeReviewArgs(args: string[]): string[] {
	const extraArgs = process.env.PI_CODERABBIT_EXTRA_ARGS ? parseCliArgs(process.env.PI_CODERABBIT_EXTRA_ARGS) : [];
	const merged = [...extraArgs, ...args].filter((arg) => !OUTPUT_MODE_ARGS.has(arg));
	if (merged[0] === "review") return ["review", "--agent", ...merged.slice(1)];
	return ["review", "--agent", ...merged];
}

function createReviewState(cwd: string, args: string[]): ReviewState {
	const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	return {
		id,
		cwd,
		command: commandCandidates()[0]!,
		args,
		startedAt: Date.now(),
		timedOut: false,
		aborted: false,
		statuses: [],
		jsonEvents: [],
		reviewEvents: [],
		findings: [],
		errorEvents: [],
		plainStdoutLines: [],
		stderrLines: [],
	};
}

function recordStatus(state: ReviewState, phase: string, status: string): void {
	state.statuses.push({ phase, status, timestamp: Date.now() });
}

function latestStatus(state: Pick<ReviewState, "statuses"> | Pick<ReviewSnapshot, "statuses">): StatusEntry | undefined {
	return state.statuses[state.statuses.length - 1];
}

function snapshotState(state: ReviewState): ReviewSnapshot {
	const latest = latestStatus(state);
	return {
		id: state.id,
		cwd: state.cwd,
		command: state.command,
		args: [...state.args],
		startedAt: state.startedAt,
		finishedAt: state.finishedAt,
		exitCode: state.exitCode,
		exitSignal: state.exitSignal,
		timedOut: state.timedOut,
		aborted: state.aborted,
		statuses: [...state.statuses],
		currentPhase: latest?.phase,
		currentStatus: latest?.status,
		jsonEventCount: state.jsonEvents.length,
		reviewEventCount: state.reviewEvents.length,
		findingCount: state.findings.length,
		errorEventCount: state.errorEvents.length,
		severityCounts: countFindingsBySeverity(state.findings),
		plainStdoutLineCount: state.plainStdoutLines.length,
		stderrLineCount: state.stderrLines.length,
		outputFile: state.outputFile,
	};
}

function phasesForDisplay(statuses: StatusEntry[]): string[] {
	const seen = new Set(statuses.map((entry) => entry.phase));
	const phases = KNOWN_PHASES.filter((phase) => seen.has(phase));
	for (const entry of statuses) {
		if (!phases.includes(entry.phase)) phases.push(entry.phase);
	}
	return phases;
}

function latestStatusForPhase(statuses: StatusEntry[], phase: string): StatusEntry | undefined {
	for (let index = statuses.length - 1; index >= 0; index--) {
		const entry = statuses[index]!;
		if (entry.phase === phase) return entry;
	}
	return undefined;
}

function phaseMarker(phase: string, snapshot: ReviewSnapshot, phaseIndex: number, currentIndex: number, theme: Theme): string {
	if (snapshot.finishedAt && snapshot.exitCode === 0 && !snapshot.timedOut && !snapshot.aborted && snapshot.errorEventCount === 0) {
		return theme.fg("success", "[x]");
	}
	if (phase === snapshot.currentPhase) return theme.fg("accent", "[>]");
	if (phaseIndex < currentIndex) return theme.fg("success", "[x]");
	return theme.fg("dim", "[ ]");
}

function buildStatusText(snapshot: ReviewSnapshot, theme: Theme): string {
	const latest = latestStatus(snapshot);
	if (snapshot.finishedAt) {
		if (snapshot.timedOut) return theme.fg("error", "cr timed out");
		if (snapshot.aborted) return theme.fg("warning", "cr aborted");
		if (snapshot.errorEventCount > 0) return theme.fg("error", "cr error");
		if (snapshot.exitCode === 0) return theme.fg("success", "cr complete");
		return theme.fg("error", `cr failed ${snapshot.exitCode ?? "?"}`);
	}
	return `${theme.fg("accent", "cr")} ${theme.fg("muted", `${humanize(latest?.phase)}: ${humanize(latest?.status)}`)}`;
}

function buildWidgetLines(snapshot: ReviewSnapshot, theme: Theme): string[] {
	const lines: string[] = [];
	const done = snapshot.finishedAt !== undefined;
	const success = snapshot.exitCode === 0 && !snapshot.timedOut && !snapshot.aborted && snapshot.errorEventCount === 0;
	const title = done
		? success
			? "CodeRabbit review complete"
			: "CodeRabbit review needs attention"
		: "CodeRabbit review running";
	lines.push(theme.fg(done ? (success ? "success" : "warning") : "accent", title));
	lines.push(theme.fg("dim", `$ ${formatCommand(snapshot.command, snapshot.args)}`));

	const phases = phasesForDisplay(snapshot.statuses);
	const currentIndex = Math.max(0, phases.indexOf(snapshot.currentPhase ?? ""));
	for (const [index, phase] of phases.entries()) {
		const status = latestStatusForPhase(snapshot.statuses, phase);
		const marker = phaseMarker(phase, snapshot, index, currentIndex, theme);
		const label = humanize(phase).padEnd(10, " ");
		lines.push(`${marker} ${theme.fg("text", label)} ${theme.fg("muted", humanize(status?.status))}`);
	}

	if (snapshot.findingCount > 0) {
		lines.push(theme.fg("warning", `${snapshot.findingCount} finding(s): ${summarizeSeverityCounts(snapshot.severityCounts)}`));
	} else if (snapshot.finishedAt && success) {
		lines.push(theme.fg("success", "No findings reported"));
	}
	if (snapshot.errorEventCount > 0) {
		lines.push(theme.fg("error", `${snapshot.errorEventCount} CodeRabbit error event(s)`));
	}
	if (snapshot.reviewEventCount > 0 || snapshot.plainStdoutLineCount > 0) {
		lines.push(
			theme.fg(
				"dim",
				`${snapshot.reviewEventCount} review event(s), ${snapshot.plainStdoutLineCount} plain line(s)`,
			),
		);
	}
	if (snapshot.stderrLineCount > 0) {
		lines.push(theme.fg(success ? "dim" : "warning", `${snapshot.stderrLineCount} stderr line(s) captured`));
	}
	if (snapshot.outputFile) lines.push(theme.fg("dim", `full output: ${snapshot.outputFile}`));

	return lines.slice(0, 12);
}

function buildProgressText(snapshot: ReviewSnapshot): string {
	const latest = latestStatus(snapshot);
	const lines = [
		`CodeRabbit review in progress`,
		`Status: ${humanize(latest?.phase)} / ${humanize(latest?.status)}`,
		`Findings: ${snapshot.findingCount} (${summarizeSeverityCounts(snapshot.severityCounts)})`,
		`Events: ${snapshot.reviewEventCount} review, ${snapshot.jsonEventCount} JSON total`,
	];
	return lines.join("\n");
}

function buildRenderedText(details: CodeRabbitToolDetails, expanded: boolean, theme: Theme): string {
	const snapshot = details.snapshot;
	const header = details.inProgress
		? theme.fg("accent", "CodeRabbit review in progress")
		: details.success
			? theme.fg("success", "CodeRabbit review complete")
			: theme.fg("warning", "CodeRabbit review failed");
	const lines = [header, ...buildWidgetLines(snapshot, theme).slice(1)];
	if (!expanded && !details.inProgress) {
		lines.push(theme.fg("dim", "Expand for review output."));
		return lines.join("\n");
	}
	if (details.summary && !details.inProgress) {
		lines.push("", details.summary);
	}
	return lines.join("\n");
}

function getTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!isJsonObject(block)) return "";
			return stringField(block, "text") ?? "";
		})
		.filter(Boolean)
		.join("\n");
}

function isCodeRabbitToolDetails(value: unknown): value is CodeRabbitToolDetails {
	if (!isJsonObject(value)) return false;
	return stringField(value, "kind") === "pi-coderabbit" && isJsonObject(value.snapshot);
}

function stringArrayField(event: JsonObject, key: string): string[] {
	const value = event[key];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeSeverity(value: string | undefined): string {
	return value?.trim().toLowerCase() || "unknown";
}

function parseFinding(event: JsonObject): CodeRabbitFinding | undefined {
	if (stringField(event, "type") !== "finding") return undefined;
	return {
		severity: normalizeSeverity(stringField(event, "severity")),
		fileName: stringField(event, "fileName") ?? stringField(event, "file") ?? "unknown file",
		codegenInstructions: stringField(event, "codegenInstructions") ?? stringField(event, "message") ?? "",
		suggestions: stringArrayField(event, "suggestions"),
		raw: event,
	};
}

function countFindingsBySeverity(findings: CodeRabbitFinding[]): SeverityCounts {
	const counts: SeverityCounts = {};
	for (const finding of findings) {
		counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
	}
	return counts;
}

function summarizeSeverityCounts(counts: SeverityCounts): string {
	const order = ["critical", "high", "medium", "low", "trivial", "info", "unknown"];
	const entries = Object.entries(counts).sort(([left], [right]) => {
		const leftRank = order.includes(left) ? order.indexOf(left) : order.length;
		const rightRank = order.includes(right) ? order.indexOf(right) : order.length;
		return leftRank - rightRank || left.localeCompare(right);
	});
	if (entries.length === 0) return "0 findings";
	return entries.map(([severity, count]) => `${count} ${severity}`).join(", ");
}

function processJsonEvent(state: ReviewState, event: JsonObject): void {
	state.jsonEvents.push(event);
	if (isStatusEvent(event)) {
		recordStatus(state, stringField(event, "phase") ?? "unknown", stringField(event, "status") ?? "unknown");
		return;
	}

	state.reviewEvents.push(event);

	const eventType = stringField(event, "type");
	if (eventType === "review_context") {
		state.reviewContext = event;
		return;
	}
	if (eventType === "error") {
		state.errorEvents.push(event);
		return;
	}

	const finding = parseFinding(event);
	if (finding) state.findings.push(finding);
}

function processStdoutLine(state: ReviewState, line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	const event = parseJsonLine(trimmed);
	if (event) {
		processJsonEvent(state, event);
		return;
	}
	state.plainStdoutLines.push(line);
}

function processStderrLine(state: ReviewState, line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	state.stderrLines.push(line);
}

class LineBuffer {
	private buffer = "";

	push(chunk: string, onLine: (line: string) => void): void {
		this.buffer += chunk;
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.buffer.slice(0, newlineIndex).replace(/\r$/u, "");
			this.buffer = this.buffer.slice(newlineIndex + 1);
			onLine(line);
			newlineIndex = this.buffer.indexOf("\n");
		}
	}

	flush(onLine: (line: string) => void): void {
		if (!this.buffer) return;
		onLine(this.buffer.replace(/\r$/u, ""));
		this.buffer = "";
	}
}

function isCommandMissing(error: unknown): boolean {
	return isJsonObject(error) && stringField(error, "code") === "ENOENT";
}

function runProcess(options: {
	command: string;
	args: string[];
	cwd: string;
	signal: AbortSignal;
	timeoutMs: number;
	onStdoutLine: (line: string) => void;
	onStderrLine: (line: string) => void;
}): Promise<ProcessExit> {
	return new Promise<ProcessExit>((resolve, reject) => {
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		child.stdin.end();

		let settled = false;
		let timedOut = false;
		let aborted = options.signal.aborted;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const stdout = new LineBuffer();
		const stderr = new LineBuffer();

		const cleanup = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			options.signal.removeEventListener("abort", abortHandler);
		};

		const terminate = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 1000);
		};

		const abortHandler = () => {
			aborted = true;
			terminate();
		};

		timeoutTimer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, options.timeoutMs);

		if (options.signal.aborted) abortHandler();
		else options.signal.addEventListener("abort", abortHandler, { once: true });

		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8"), options.onStdoutLine));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8"), options.onStderrLine));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			stdout.flush(options.onStdoutLine);
			stderr.flush(options.onStderrLine);
			cleanup();
			resolve({ code, signal, timedOut, aborted });
		});
	});
}

async function writeFullOutput(state: ReviewState, output: string): Promise<string> {
	const directory = join(tmpdir(), "pi-coderabbit");
	await mkdir(directory, { recursive: true });
	const file = join(directory, `${state.id}.txt`);
	await writeFile(file, output, "utf8");
	return file;
}

function buildRawOutput(state: ReviewState): string {
	const lines: string[] = [];
	for (const event of state.reviewEvents) lines.push(JSON.stringify(event));
	if (state.plainStdoutLines.length > 0) {
		lines.push("", "[plain stdout]");
		lines.push(...state.plainStdoutLines);
	}
	if (state.stderrLines.length > 0) {
		lines.push("", "[stderr]");
		lines.push(...state.stderrLines);
	}
	return lines.join("\n").trim();
}

function contextLine(state: ReviewState): string | undefined {
	const context = state.reviewContext;
	if (!context) return undefined;
	const reviewType = stringField(context, "reviewType");
	const currentBranch = stringField(context, "currentBranch");
	const baseBranch = stringField(context, "baseBranch");
	const workingDirectory = stringField(context, "workingDirectory");
	const parts = [
		reviewType ? `type ${reviewType}` : undefined,
		currentBranch ? `branch ${currentBranch}` : undefined,
		baseBranch ? `base ${baseBranch}` : undefined,
		workingDirectory ? `cwd ${workingDirectory}` : undefined,
	].filter((part): part is string => !!part);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function groupFindingsByFile(findings: CodeRabbitFinding[]): Map<string, CodeRabbitFinding[]> {
	const grouped = new Map<string, CodeRabbitFinding[]>();
	for (const finding of findings) {
		const current = grouped.get(finding.fileName) ?? [];
		current.push(finding);
		grouped.set(finding.fileName, current);
	}
	return grouped;
}

function buildFindingReport(state: ReviewState): string {
	const lines: string[] = [];
	const context = contextLine(state);
	if (context) lines.push(`Review context: ${context}`, "");

	if (state.errorEvents.length > 0) {
		lines.push("CodeRabbit error events:");
		for (const event of state.errorEvents) {
			const errorType = stringField(event, "errorType") ?? "error";
			const message = stringField(event, "message") ?? JSON.stringify(event);
			lines.push(`- ${errorType}: ${message}`);
		}
		lines.push("");
	}

	if (state.findings.length === 0) {
		lines.push("No CodeRabbit findings were reported.");
		return lines.join("\n").trim();
	}

	lines.push(`CodeRabbit findings: ${state.findings.length} (${summarizeSeverityCounts(countFindingsBySeverity(state.findings))})`, "");

	for (const [fileName, findings] of groupFindingsByFile(state.findings)) {
		lines.push(`## ${fileName}`);
		findings.forEach((finding, index) => {
			lines.push("", `### Finding ${index + 1}: ${finding.severity}`);
			if (finding.codegenInstructions) {
				lines.push("", finding.codegenInstructions.trim());
			}
			if (finding.suggestions.length > 0) {
				lines.push("", "Suggestions:");
				finding.suggestions.forEach((suggestion, suggestionIndex) => {
					lines.push("", `Suggestion ${suggestionIndex + 1}:`, "```", suggestion, "```");
				});
			}
		});
		lines.push("");
	}

	return lines.join("\n").trim();
}

function buildReviewOutput(state: ReviewState): string {
	const findingReport = buildFindingReport(state);
	const rawOutput = buildRawOutput(state);
	if (!rawOutput || state.findings.length > 0 || state.errorEvents.length > 0) return findingReport;
	return rawOutput;
}

async function buildResult(state: ReviewState): Promise<ReviewResult> {
	const output = buildReviewOutput(state);
	const truncation = truncateTail(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (truncation.truncated && output) {
		state.outputFile = await writeFullOutput(state, output);
	}

	const snapshot = snapshotState(state);
	const success = state.exitCode === 0 && !state.timedOut && !state.aborted && state.errorEvents.length === 0;
	const duration = formatDuration((state.finishedAt ?? Date.now()) - state.startedAt);
	const latest = latestStatus(state);
	const lines = [
		`CodeRabbit review ${success ? "completed" : "failed"}`,
		`Command: ${formatCommand(state.command, state.args)}`,
		`Duration: ${duration}`,
		`Latest status: ${humanize(latest?.phase)} / ${humanize(latest?.status)}`,
		`Findings: ${state.findings.length} (${summarizeSeverityCounts(countFindingsBySeverity(state.findings))})`,
		`Events: ${state.reviewEvents.length} review event(s), ${state.jsonEvents.length} JSON event(s) total`,
	];

	if (state.exitCode !== undefined) lines.push(`Exit: ${state.exitCode ?? "signal"}${state.exitSignal ? ` (${state.exitSignal})` : ""}`);
	if (state.timedOut) lines.push("Reason: timed out");
	if (state.aborted) lines.push("Reason: aborted");
	if (state.errorEvents.length > 0) lines.push(`Reason: ${state.errorEvents.length} CodeRabbit error event(s)`);
	if (!output) lines.push("", "No non-status CodeRabbit review payload was emitted.");
	else {
		lines.push("", "Review output:", truncation.content);
		if (truncation.truncated && state.outputFile) {
			lines.push(
				"",
				`[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${state.outputFile}]`,
			);
		}
	}

	return {
		success,
		snapshot,
		summary: lines.join("\n"),
		output,
		outputFile: state.outputFile,
	};
}

export default function piCodeRabbitExtension(pi: ExtensionAPI) {
	let activeController: AbortController | undefined;
	let activeState: ReviewState | undefined;
	let latestSnapshot: ReviewSnapshot | undefined;

	function applyReviewUi(ctx: ExtensionContext, state: ReviewState): void {
		const snapshot = snapshotState(state);
		latestSnapshot = snapshot;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, buildStatusText(snapshot, ctx.ui.theme));
		ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(snapshot, ctx.ui.theme));

		if (!state.finishedAt && envFlagEnabled("PI_CODERABBIT_WORKING_INDICATOR", true)) {
			ctx.ui.setWorkingMessage(`CodeRabbit: ${humanize(snapshot.currentStatus)}`);
			ctx.ui.setWorkingIndicator({
				frames: [
					ctx.ui.theme.fg("dim", "cr"),
					ctx.ui.theme.fg("muted", "cR"),
					ctx.ui.theme.fg("accent", "CR"),
					ctx.ui.theme.fg("muted", "cR"),
				],
				intervalMs: 140,
			});
			return;
		}

		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
	}

	function clearReviewUi(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
	}

	function publishProgress(ctx: ExtensionContext, state: ReviewState, onUpdate?: ToolUpdate): void {
		applyReviewUi(ctx, state);
		if (!onUpdate) return;
		const snapshot = snapshotState(state);
		onUpdate({
			content: [{ type: "text", text: buildProgressText(snapshot) }],
			details: {
				kind: "pi-coderabbit",
				inProgress: true,
				snapshot,
			},
		});
	}

	async function runReview(
		ctx: ExtensionContext,
		rawArgs: string[],
		options: { signal?: AbortSignal; timeoutMs?: number; onUpdate?: ToolUpdate } = {},
	): Promise<ReviewResult> {
		if (activeController) {
			throw new Error("A CodeRabbit review is already running. Use /coderabbit-cancel to stop it first.");
		}

		const args = normalizeReviewArgs(rawArgs);
		const state = createReviewState(ctx.cwd, args);
		const candidates = commandCandidates();
		const controller = new AbortController();
		const timeoutMs = options.timeoutMs ?? envNumber("PI_CODERABBIT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
		activeController = controller;
		activeState = state;

		const parentAbort = () => controller.abort();
		if (options.signal?.aborted) controller.abort();
		else options.signal?.addEventListener("abort", parentAbort, { once: true });

		try {
			recordStatus(state, "setup", "starting_cli");
			publishProgress(ctx, state, options.onUpdate);

			let lastError: unknown;
			for (const command of candidates) {
				state.command = command;
				publishProgress(ctx, state, options.onUpdate);
				try {
					const exit = await runProcess({
						command,
						args,
						cwd: ctx.cwd,
						signal: controller.signal,
						timeoutMs,
						onStdoutLine: (line) => {
							processStdoutLine(state, line);
							publishProgress(ctx, state, options.onUpdate);
						},
						onStderrLine: (line) => {
							processStderrLine(state, line);
							publishProgress(ctx, state, options.onUpdate);
						},
					});
					state.exitCode = exit.code;
					state.exitSignal = exit.signal;
					state.timedOut = exit.timedOut;
					state.aborted = exit.aborted;
					break;
				} catch (error) {
					lastError = error;
					if (isCommandMissing(error) && command !== candidates[candidates.length - 1]) {
						processStderrLine(state, `${command}: command not found, trying next CodeRabbit binary`);
						continue;
					}
					throw error;
				}
			}

			if (state.exitCode === undefined && lastError) throw lastError;
		} catch (error) {
			state.exitCode = state.exitCode ?? 1;
			processStderrLine(state, error instanceof Error ? error.message : String(error));
		} finally {
			options.signal?.removeEventListener("abort", parentAbort);
			const finalStatus = state.timedOut
				? "timed_out"
				: state.aborted
					? "aborted"
					: state.errorEvents.length > 0
						? "error"
						: state.exitCode === 0
							? "complete"
							: "failed";
			recordStatus(state, "complete", finalStatus);
			state.finishedAt = Date.now();
			activeController = undefined;
			activeState = undefined;
		}

		const result = await buildResult(state);
		applyReviewUi(ctx, state);
		return result;
	}

	async function runCommandReview(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const result = await runReview(ctx, parseCliArgs(args));
		pi.sendMessage({
			customType: MESSAGE_TYPE,
			content: result.summary,
			display: true,
			details: {
				kind: "pi-coderabbit",
				inProgress: false,
				success: result.success,
				snapshot: result.snapshot,
				summary: result.summary,
			} satisfies CodeRabbitToolDetails,
		});
		ctx.ui.notify(result.success ? "CodeRabbit review complete" : "CodeRabbit review failed", result.success ? "info" : "error");
	}

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = isCodeRabbitToolDetails(message.details) ? message.details : undefined;
		if (!details) return new Text(String(message.content), 0, 0);
		return new Text(buildRenderedText(details, expanded, theme), 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!latestSnapshot) clearReviewUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeController?.abort();
		activeController = undefined;
		activeState = undefined;
		clearReviewUi(ctx);
	});

	pi.registerCommand("coderabbit-review", {
		description: "Run CodeRabbit CLI in --agent mode and show live review progress.",
		handler: async (args, ctx) => {
			await runCommandReview(args, ctx);
		},
	});

	pi.registerCommand("coderabbit-status", {
		description: "Show the latest CodeRabbit review status.",
		handler: async (_args, ctx) => {
			const snapshot = activeState ? snapshotState(activeState) : latestSnapshot;
			if (!snapshot) {
				ctx.ui.notify("No CodeRabbit review has run in this session", "info");
				return;
			}
			const ok = snapshot.exitCode === 0 && snapshot.errorEventCount === 0 && !snapshot.timedOut && !snapshot.aborted;
			ctx.ui.notify(buildStatusText(snapshot, ctx.ui.theme), activeState || ok ? "info" : "warning");
		},
	});

	pi.registerCommand("coderabbit-cancel", {
		description: "Cancel the running CodeRabbit review.",
		handler: async (_args, ctx) => {
			if (!activeController) {
				ctx.ui.notify("No CodeRabbit review is running", "warning");
				return;
			}
			activeController.abort();
			ctx.ui.notify("Cancelling CodeRabbit review", "info");
		},
	});

	pi.registerCommand("coderabbit-clear", {
		description: "Clear CodeRabbit status and widget UI.",
		handler: async (_args, ctx) => {
			latestSnapshot = undefined;
			clearReviewUi(ctx);
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Run the CodeRabbit CLI in agent JSON mode, stream progress into pi's UI, and return the review output to the agent.",
		promptSnippet: "Run CodeRabbit CLI review with live JSON progress/status UI.",
		promptGuidelines: [
			"Use coderabbit_review when the user asks to run a CodeRabbit review or wants CodeRabbit feedback on the current changes.",
			"The coderabbit_review tool already forces CodeRabbit --agent mode and parses JSONL status events for progress.",
		],
		parameters: ReviewParamsSchema,
		async execute(_toolCallId, params: ReviewParams, signal, onUpdate, ctx) {
			const result = await runReview(ctx, params.args ?? [], {
				signal,
				timeoutMs: params.timeoutMs,
				onUpdate: onUpdate as ToolUpdate | undefined,
			});
			const details: CodeRabbitToolDetails = {
				kind: "pi-coderabbit",
				inProgress: false,
				success: result.success,
				snapshot: result.snapshot,
				summary: result.summary,
			};
			return {
				content: [{ type: "text" as const, text: result.summary }],
				details,
			};
		},
		renderCall(args, theme) {
			const reviewArgs = normalizeReviewArgs(args.args ?? []);
			return new Text(`${theme.fg("toolTitle", "coderabbit_review")} ${theme.fg("dim", formatCommand("coderabbit", reviewArgs))}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = isCodeRabbitToolDetails(result.details) ? result.details : undefined;
			if (details) return new Text(buildRenderedText(details, expanded || isPartial, theme), 0, 0);
			const text = getTextContent(result.content);
			if (!text) return new Container();
			return new Text(text, 0, 0);
		},
	});
}
