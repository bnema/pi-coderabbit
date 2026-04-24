# pi-coderabbit

Pi package that turns CodeRabbit CLI `--agent` JSONL output into live review progress inside pi.

## What it adds

- `coderabbit_review` tool for running CodeRabbit from the agent
- `/coderabbit-review` command for manual runs
- live footer status, editor widget, and working indicator while CodeRabbit is running
- JSONL parser for CodeRabbit `status`, `review_context`, `finding`, and `error` events
- final finding report grouped by file with severity, CodeRabbit codegen instructions, and suggestions
- safe fallback that preserves unknown JSON events and plain stdout/stderr

## Install

From GitHub:

```bash
pi install https://github.com/bnema/pi-coderabbit
```

Try it for one session without installing:

```bash
pi -e https://github.com/bnema/pi-coderabbit
```

Local development:

```bash
cd /path/to/pi-coderabbit
npm install
npm run typecheck
pi -e .
```

## Requirements

Install and authenticate the CodeRabbit CLI first:

```bash
coderabbit auth login
coderabbit auth status
```

The extension looks for `coderabbit`, then `cr`. Override the binary with:

```bash
PI_CODERABBIT_BIN=/path/to/coderabbit pi
```

## Usage

Ask pi to run CodeRabbit, or call the tool directly.

Example prompts:

```text
Run a CodeRabbit review on my uncommitted changes and fix the findings.
Run CodeRabbit against main and summarize the findings.
```

Slash commands:

- `/coderabbit-review` — run `coderabbit review --agent`
- `/coderabbit-review --type uncommitted` — pass extra CodeRabbit review args
- `/coderabbit-review --base main --type committed` — compare against a base branch
- `/coderabbit-status` — show latest review state
- `/coderabbit-cancel` — abort the current review
- `/coderabbit-clear` — clear the status/widget UI

Tool parameters:

```json
{
  "args": ["--type", "uncommitted", "--base", "main"],
  "timeoutMs": 600000
}
```

The extension always forces CodeRabbit agent mode by running `coderabbit review --agent ...`.

## CodeRabbit JSONL support

CodeRabbit `--agent` emits newline-delimited JSON. The progress UX uses `status` events:

```json
{"type":"status","phase":"setup","status":"setting_up"}
{"type":"status","phase":"setup","status":"preparing_sandbox"}
{"type":"status","phase":"analyzing","status":"summarizing"}
{"type":"status","phase":"analyzing","status":"tools_completed"}
{"type":"status","phase":"analyzing","status":"reviewing"}
```

The extension also handles context events:

```json
{"type":"review_context","reviewType":"uncommitted","currentBranch":"main","baseBranch":"main","workingDirectory":"/repo"}
```

And final findings:

```json
{
  "type": "finding",
  "severity": "trivial",
  "fileName": ".gitignore",
  "codegenInstructions": "Verify each finding against the current code and only fix it if needed...",
  "suggestions": ["node_modules/\ndist/\nout/\nbuild/\n*.vsix\n.vscode-test/"]
}
```

Known finding fields are normalized into a readable final report:

- severity counts
- grouped file sections
- CodeRabbit `codegenInstructions`
- `suggestions` blocks

Unknown JSON objects are kept in the raw review payload so newer CodeRabbit event types remain visible to the agent.

## Configuration

Environment variables:

- `PI_CODERABBIT_BIN` — exact CodeRabbit binary to execute. Defaults to `coderabbit`, then `cr`.
- `PI_CODERABBIT_EXTRA_ARGS` — extra args prepended to every run, for example `--type uncommitted`.
- `PI_CODERABBIT_TIMEOUT_MS` — default timeout. Defaults to `600000`.
- `PI_CODERABBIT_WORKING_INDICATOR=0` — disable the custom working indicator.

## Notes

- CodeRabbit reviews can take several minutes.
- The tool does not apply suggestions automatically. It returns findings to the agent so the agent can verify and patch them.
- On large output, the extension truncates the result sent to the model and writes the full report to a temp file.
