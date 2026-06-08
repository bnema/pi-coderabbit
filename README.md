# pi-coderabbit

Run CodeRabbit reviews from Pi and show live progress while the review is running.

## What it does

- Adds the `coderabbit_review` tool.
- Adds `/coderabbit-review`, `/coderabbit-status`, `/coderabbit-cancel`, and `/coderabbit-clear`.
- Streams CodeRabbit `--agent` JSONL events into Pi status UI.
- Reports findings grouped by file with severity, suggestions, and CodeRabbit codegen instructions.

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

Override the binary if needed:

```bash
PI_CODERABBIT_BIN=/path/to/coderabbit pi
```

## Use

Ask Pi to run CodeRabbit, or run a slash command:

```text
/coderabbit-review
/coderabbit-review --type uncommitted
/coderabbit-review --type committed --base main
```

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
