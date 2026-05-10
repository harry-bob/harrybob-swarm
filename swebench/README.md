# SWE-Bench Verified — Swarm Evaluation

Run the Swarm multi-agent system on [SWE-Bench Verified](https://www.swebench.com/) and evaluate its performance.

## Overview

SWE-Bench Verified contains 500 human-verified GitHub issues from popular Python repositories. Each task requires the agent to:

1. Read the issue description
2. Explore the codebase
3. Generate a fix (git patch)
4. Pass the test suite

## Setup

### 1. Install Dependencies

```bash
cd swebench
pip install -r requirements.txt
```

### 2. Install Swarm

```bash
cd ..
npm install
npm run build
npm link
```

### 3. Set Up Ollama

```bash
ollama pull qwen3.5:397b-cloud
```

## Running

### Quick Test (5 instances)

```bash
cd swebench
python run.py --limit 5 --output predictions_test.jsonl
```

### Run All 500 Instances

```bash
python run.py --output predictions.jsonl
```

### Run Specific Instance

```bash
python run.py --instance-id sympy__sympy-20048
```

### Resume After Interruption

```bash
python run.py --output predictions.jsonl --resume
```

### Parallel (Run Multiple Instances)

Use tmux or GNU parallel to run multiple batches:

```bash
# Terminal 1: instances 0-99
python run.py --start 0 --limit 100 --output predictions_0.jsonl

# Terminal 2: instances 100-199
python run.py --start 100 --limit 100 --output predictions_1.jsonl

# Terminal 3: instances 200-299
python run.py --start 200 --limit 100 --output predictions_2.jsonl
```

Then merge:
```bash
cat predictions_0.jsonl predictions_1.jsonl predictions_2.jsonl > predictions.jsonl
```

## Evaluation

### Prerequisites

- Docker installed and running
- `swebench` package installed

### Run Evaluation

```bash
python evaluate.py --predictions predictions.jsonl --run-id swarm-v1
```

This will:
1. For each prediction, clone the repo at the base commit
2. Apply the generated patch
3. Run the test suite
4. Report how many issues were resolved

### Results Format

```
═══════════════════════════════════════════════════════════
EVALUATION RESULTS
═══════════════════════════════════════════════════════════
  Total:    500
  Resolved: 123
  Rate:     24.6%
═══════════════════════════════════════════════════════════
```

## Output Format

### predictions.jsonl

Each line is a JSON object:

```json
{
  "instance_id": "sympy__sympy-20048",
  "model_patch": "diff --git a/sympy/core/expr.py\n...",
  "model_name_or_path": "swarm"
}
```

### results_<run-id>.json

Detailed per-instance results:

```json
{
  "sympy__sympy-20048": {
    "resolved": true,
    "tests_passed": ["test_issue_20048"],
    "tests_failed": []
  }
}
```

## Customization

### Use a Different Model

```bash
# Before running, change the model
swarm model set deepseek-v3.2:cloud

# Then run
python run.py --limit 10
```

### Use a Different Swarm Binary

```bash
SWARM_BIN=/path/to/swarm python run.py --limit 10
```

### Adjust Timeout

```bash
python run.py --timeout 900  # 15 min per instance
```

## Troubleshooting

### "swarm: command not found"

Make sure you ran `npm link` in the swarm project directory.

### "model not found"

Make sure Ollama is running and has a model pulled:
```bash
ollama list
ollama pull qwen3.5:397b-cloud
```

### Docker errors during evaluation

Make sure Docker is running:
```bash
docker info
```

### Out of disk space

Each instance clones a repo. Use `--work-dir` to specify a location with enough space:
```bash
python run.py --work-dir /data/swebench-work
```

## Architecture

```
run.py
  ├─ Load SWE-Bench Verified dataset
  ├─ For each instance:
  │   ├─ Clone repo at base_commit
  │   ├─ Run: swarm run "Fix this issue: <description>"
  │   ├─ Capture: git diff (the patch)
  │   └─ Save to predictions.jsonl
  └─ Summary

evaluate.py
  ├─ Load predictions.jsonl
  ├─ For each prediction:
  │   ├─ Clone repo at base_commit
  │   ├─ Apply patch
  │   ├─ Run test suite
  │   └─ Check if tests pass
  └─ Report resolution rate
```
