#!/usr/bin/env python3
"""
SWE-Bench Verified runner for Swarm.

Runs the Swarm multi-agent system on SWE-Bench Verified instances
and generates predictions (git patches) for evaluation.

Usage:
    python run.py                              # Run all instances
    python run.py --limit 10                   # Run first 10 instances
    python run.py --instance-id sympy__sympy-12345  # Run specific instance
    python run.py --output predictions.jsonl   # Custom output file
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import tempfile
from pathlib import Path
from datetime import datetime

try:
    from datasets import load_dataset
except ImportError:
    print("ERROR: 'datasets' package not installed. Run: pip install datasets")
    sys.exit(1)


# ── Defaults ─────────────────────────────────────────────────────

SWARM_BIN = os.environ.get("SWARM_BIN", "swarm")
DATASET_NAME = "princeton-nlp/SWE-bench_Verified"
DATASET_SPLIT = "test"
WORK_DIR = Path(tempfile.gettempdir()) / "swebench-swarm"
OUTPUT_FILE = "predictions.jsonl"
TIMEOUT_SECONDS = 600  # 10 min per instance


# ── Helpers ───────────────────────────────────────────────────────

def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def run_cmd(cmd: list[str], cwd: str | Path | None = None,
            timeout: int | None = None, check: bool = True,
            capture: bool = False) -> subprocess.CompletedProcess:
    """Run a shell command with optional timeout."""
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        timeout=timeout,
        check=check,
        capture_output=capture,
        text=True,
    )


def clone_and_checkout(repo: str, base_commit: str, target_dir: Path):
    """Clone a repo and checkout the base commit."""
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True)

    run_cmd(
        ["git", "clone", "--depth=1", f"https://github.com/{repo}.git", str(target_dir)],
        timeout=120,
    )
    # Fetch the specific commit (shallow clone may not have it)
    run_cmd(["git", "fetch", "--depth=1", "origin", base_commit], cwd=target_dir, check=False)
    run_cmd(["git", "checkout", base_commit], cwd=target_dir, check=True)


def get_git_diff(repo_dir: Path) -> str:
    """Capture all changes as a git diff (including untracked files)."""
    # Stage all changes (tracked + untracked)
    run_cmd(["git", "add", "-A"], cwd=repo_dir)
    # Get the diff of staged changes
    result = run_cmd(["git", "diff", "--cached"], cwd=repo_dir, capture=True)
    return result.stdout


def reset_repo(repo_dir: Path):
    """Reset the repo to a clean state."""
    run_cmd(["git", "checkout", "."], cwd=repo_dir, check=False)
    run_cmd(["git", "clean", "-fd"], cwd=repo_dir, check=False)


def run_swarm_on_instance(
    instance: dict,
    work_dir: Path,
    swarm_bin: str,
    timeout: int,
    verbose: bool = False,
) -> dict:
    """
    Run Swarm on a single SWE-Bench instance.

    Returns:
        dict with instance_id and model_patch
    """
    instance_id = instance["instance_id"]
    repo = instance["repo"]
    base_commit = instance["base_commit"]
    problem = instance["problem_statement"]

    repo_dir = work_dir / instance_id.replace("/", "__")

    log(f"[{instance_id}] Setting up repo...")
    try:
        clone_and_checkout(repo, base_commit, repo_dir)
    except Exception as e:
        log(f"[{instance_id}] Failed to clone: {e}")
        return {"instance_id": instance_id, "model_patch": "", "error": str(e)}

    # Build the task prompt
    task = (
        f"Fix the following GitHub issue. Make the minimal changes needed to fix "
        f"the bug. Do NOT modify test files unless absolutely necessary. Only "
        f"modify source code files to fix the underlying issue.\n\n"
        f"---\n{problem}\n---"
    )

    # Run swarm
    log(f"[{instance_id}] Running swarm...")
    try:
        env = os.environ.copy()
        result = subprocess.run(
            [swarm_bin, "run", task],
            cwd=str(repo_dir),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        if verbose:
            log(f"[{instance_id}] Swarm stdout:\n{result.stdout[-500:]}")
            if result.stderr:
                log(f"[{instance_id}] Swarm stderr:\n{result.stderr[-500:]}")
    except subprocess.TimeoutExpired:
        log(f"[{instance_id}] Timeout after {timeout}s")
        return {"instance_id": instance_id, "model_patch": "", "error": "timeout"}
    except Exception as e:
        log(f"[{instance_id}] Swarm failed: {e}")
        return {"instance_id": instance_id, "model_patch": "", "error": str(e)}

    # Capture the patch
    patch = get_git_diff(repo_dir)

    if patch:
        log(f"[{instance_id}] ✅ Patch generated ({len(patch)} chars)")
    else:
        log(f"[{instance_id}] ⚠ No changes made")

    return {"instance_id": instance_id, "model_patch": patch}


# ── Main ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Run Swarm on SWE-Bench Verified instances"
    )
    parser.add_argument(
        "--dataset", default=DATASET_NAME,
        help=f"HuggingFace dataset name (default: {DATASET_NAME})"
    )
    parser.add_argument(
        "--split", default=DATASET_SPLIT,
        help=f"Dataset split (default: {DATASET_SPLIT})"
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Max number of instances to run"
    )
    parser.add_argument(
        "--instance-id", type=str, default=None,
        help="Run a specific instance by ID"
    )
    parser.add_argument(
        "--start", type=int, default=0,
        help="Start index for batch processing"
    )
    parser.add_argument(
        "--output", type=str, default=OUTPUT_FILE,
        help=f"Output predictions file (default: {OUTPUT_FILE})"
    )
    parser.add_argument(
        "--work-dir", type=str, default=str(WORK_DIR),
        help=f"Working directory for cloned repos (default: {WORK_DIR})"
    )
    parser.add_argument(
        "--swarm-bin", type=str, default=SWARM_BIN,
        help=f"Path to swarm binary (default: {SWARM_BIN})"
    )
    parser.add_argument(
        "--timeout", type=int, default=TIMEOUT_SECONDS,
        help=f"Timeout per instance in seconds (default: {TIMEOUT_SECONDS})"
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Show verbose output"
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Resume from existing predictions file (skip completed instances)"
    )

    args = parser.parse_args()

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    # ── Load dataset ──────────────────────────────────────────
    log(f"Loading dataset: {args.dataset} (split: {args.split})...")
    try:
        dataset = load_dataset(args.dataset, split=args.split)
    except Exception as e:
        log(f"ERROR: Failed to load dataset: {e}")
        sys.exit(1)

    log(f"Dataset loaded: {len(dataset)} instances")

    # ── Filter instances ──────────────────────────────────────
    if args.instance_id:
        instances = [inst for inst in dataset if inst["instance_id"] == args.instance_id]
        if not instances:
            log(f"ERROR: Instance '{args.instance_id}' not found")
            sys.exit(1)
    else:
        instances = list(dataset)
        if args.start > 0:
            instances = instances[args.start:]
        if args.limit:
            instances = instances[:args.limit]

    # ── Resume: skip already completed ────────────────────────
    completed_ids = set()
    if args.resume and os.path.exists(args.output):
        with open(args.output) as f:
            for line in f:
                pred = json.loads(line)
                completed_ids.add(pred["instance_id"])
        instances = [i for i in instances if i["instance_id"] not in completed_ids]
        log(f"Resuming: {len(completed_ids)} already done, {len(instances)} remaining")

    log(f"Running swarm on {len(instances)} instance(s)...")
    log(f"Timeout: {args.timeout}s per instance")
    log(f"Work dir: {work_dir}")
    log(f"Output: {args.output}")
    log("─" * 60)

    # ── Run ───────────────────────────────────────────────────
    predictions = []
    start_time = time.time()
    open_mode = "a" if args.resume and os.path.exists(args.output) else "w"

    with open(args.output, open_mode) as f:
        for idx, instance in enumerate(instances):
            instance_id = instance["instance_id"]
            log(f"\n[{idx + 1}/{len(instances)}] Processing: {instance_id}")

            result = run_swarm_on_instance(
                instance=instance,
                work_dir=work_dir,
                swarm_bin=args.swarm_bin,
                timeout=args.timeout,
                verbose=args.verbose,
            )

            # Write prediction immediately (for crash safety)
            pred = {
                "instance_id": result["instance_id"],
                "model_patch": result["model_patch"],
                "model_name_or_path": "swarm",
            }
            if "error" in result:
                pred["error"] = result["error"]

            f.write(json.dumps(pred) + "\n")
            f.flush()
            predictions.append(pred)

            # Cleanup repo to save disk space
            repo_dir = work_dir / instance_id.replace("/", "__")
            if repo_dir.exists():
                shutil.rmtree(repo_dir, ignore_errors=True)

            elapsed = time.time() - start_time
            avg = elapsed / (idx + 1)
            remaining = avg * (len(instances) - idx - 1)
            log(f"  Progress: {idx + 1}/{len(instances)} | "
                f"Elapsed: {elapsed:.0f}s | "
                f"Avg: {avg:.0f}s/inst | "
                f"ETA: {remaining:.0f}s")

    # ── Summary ───────────────────────────────────────────────
    elapsed = time.time() - start_time
    patches_generated = sum(1 for p in predictions if p["model_patch"])
    errors = sum(1 for p in predictions if "error" in p)

    log("\n" + "═" * 60)
    log("SUMMARY")
    log("═" * 60)
    log(f"  Total instances:  {len(predictions)}")
    log(f"  Patches generated: {patches_generated}")
    log(f"  No changes:       {len(predictions) - patches_generated}")
    log(f"  Errors:           {errors}")
    log(f"  Total time:       {elapsed:.0f}s ({elapsed / 60:.1f}min)")
    log(f"  Avg per instance: {elapsed / len(predictions):.0f}s")
    log(f"  Predictions:      {args.output}")
    log("═" * 60)

    log(f"\nTo evaluate, run:")
    log(f"  python evaluate.py --predictions {args.output}")


if __name__ == "__main__":
    main()
