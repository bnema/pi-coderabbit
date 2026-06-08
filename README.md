# pi-coderabbit

Run CodeRabbit reviews from Pi and show live progress while the review is running.

## What it does

- Adds the `coderabbit_review` tool.
- Adds `/coderabbit-review`, `/coderabbit-status`, `/coderabbit-cancel`, and `/coderabbit-clear`.
- Streams CodeRabbit `--agent` JSONL events into Pi status UI.
- Reports findings grouped by file with severity, suggestions, and CodeRabbit codegen instructions.
- Preserves unknown JSON events and plain stdout/stderr so new CodeRabbit output remains visible.

## Install

```bash
pi install git:github.com/bnema/pi-coderabbit
```

## Requirements

Install and authenticate the CodeRabbit CLI first:

```bash
coderabbit auth login
coderabbit auth status
```

By default, the extension runs `coderabbit` and falls back to `cr`. Override the binary if needed:

```bash
PI_CODERABBIT_BIN=/path/to/coderabbit pi
```

## Use

Ask Pi to run CodeRabbit, or run a slash command:

```text
/coderabbit-review
/coderabbit-review --type uncommitted
/coderabbit-review --type committed --base main
/coderabbit-review --type all --base main
/coderabbit-status
/coderabbit-cancel
/coderabbit-clear
```

The extension always runs CodeRabbit in agent mode:

```bash
coderabbit review --agent ...
```

With no arguments, CodeRabbit uses its default `--type all` scope, which reviews committed and uncommitted local changes. If no base is passed, CodeRabbit infers it.

## Tool

The `coderabbit_review` tool accepts:

```json
{
  "args": ["--type", "uncommitted", "--base", "main"],
  "timeoutMs": 600000
}
```

`args` are appended to `coderabbit review --agent`. `timeoutMs` overrides the default run timeout for that call.

## Configuration

Environment variables:

- `PI_CODERABBIT_BIN` — exact CodeRabbit binary. Defaults to `coderabbit`, then `cr`.
- `PI_CODERABBIT_EXTRA_ARGS` — extra args prepended to every run, for example `--type uncommitted`.
- `PI_CODERABBIT_TIMEOUT_MS` — default timeout in milliseconds. Defaults to `600000`.
- `PI_CODERABBIT_WORKING_INDICATOR=0` — disable the custom working indicator.

## Output notes

CodeRabbit `--agent` emits newline-delimited JSON. The extension uses `status`, `review_context`, `finding`, and `error` events for progress and final reporting. Known finding fields are normalized into severity counts and per-file sections. Unknown JSON objects stay in the raw review payload.

CodeRabbit reviews can take several minutes. The tool does not apply suggestions automatically; it returns findings to the agent for verification. Large results are truncated in model context and the full report is written to a temp file.

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
