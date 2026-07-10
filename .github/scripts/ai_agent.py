# .github/scripts/ai_agent.py
# Model-agnostic AI agent for GitHub Actions.
# Supports: openai / anthropic / deepseek / openrouter / ollama / custom
#
# Usage:
#   LLM_PROVIDER=deepseek LLM_MODEL=deepseek-chat DEEPSEEK_API_KEY=sk-... \
#     python .github/scripts/ai_agent.py

import os, sys, subprocess
from openai import OpenAI


def _write_output(name: str, value: str):
    """Write a multi-line value to GITHUB_OUTPUT and stdout."""
    print(value)
    output_path = os.getenv("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a") as f:
            f.write(f"{name}<<EOF\n{value}\nEOF\n")


# === Model selection via env vars ===
PROVIDER = os.getenv("LLM_PROVIDER", "openai")
MODEL = os.getenv("LLM_MODEL", "gpt-4o")

# === Provider routing table ===
# Add new endpoints here to support any OpenAI-compatible API.
ENDPOINTS = {
    "openai":     {"base_url": "https://api.openai.com/v1",           "key_env": "OPENAI_API_KEY"},
    "anthropic":  {"base_url": "https://api.anthropic.com/v1",        "key_env": "ANTHROPIC_API_KEY"},
    "deepseek":   {"base_url": "https://api.deepseek.com/v1",         "key_env": "DEEPSEEK_API_KEY"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1",        "key_env": "OPENROUTER_API_KEY"},
    "custom":     {"base_url": os.getenv("LLM_BASE_URL", ""),         "key_env": "LLM_API_KEY"},
}

# — Init client —
if PROVIDER == "ollama":
    base = os.getenv("OLLAMA_HOST", "http://localhost:11434/v1")
    client = OpenAI(base_url=base, api_key="ollama")
    MODEL = os.getenv("LLM_MODEL", "qwen2.5-coder:14b")
else:
    cfg = ENDPOINTS.get(PROVIDER) or ENDPOINTS["custom"]
    api_key = os.getenv(cfg["key_env"])
    if not api_key:
        print(f"::error::Missing API key env var: {cfg['key_env']} for provider={PROVIDER}")
        sys.exit(1)
    client = OpenAI(base_url=cfg["base_url"], api_key=api_key)


def call_llm(system: str, user: str) -> str:
    """Call the configured LLM with system + user messages."""
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
        temperature=0.1,
        max_tokens=4096,
    )
    return resp.choices[0].message.content


def get_diff() -> str:
    """Get git diff between the PR base and HEAD."""
    base = os.getenv("GITHUB_BASE_REF", "main")
    try:
        diff = subprocess.run(
            ["git", "diff", f"origin/{base}...HEAD", "--",
             ":!package-lock.json", ":!pnpm-lock.yaml"],
            capture_output=True, text=True, check=True, timeout=30
        ).stdout
    except subprocess.CalledProcessError:
        diff = subprocess.run(
            ["git", "diff", "HEAD"],
            capture_output=True, text=True, timeout=15
        ).stdout
    # Truncate to avoid token overflow
    MAX_DIFF_CHARS = 40000
    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS] + "\n# ... (diff truncated)"
    return diff


def get_pr_context() -> dict:
    """Read GitHub Actions env vars for PR context."""
    return {
        "repo":   os.getenv("GITHUB_REPOSITORY", "unknown/repo"),
        "pr_num": os.getenv("GITHUB_REF_NAME", "").replace("refs/pull/", "").split("/")[0],
        "sha":    os.getenv("GITHUB_SHA", ""),
    }


def review_action():
    """Review PR diff."""
    diff = get_diff()
    if not diff.strip():
        _write_output("review_body", "No diff to review.")
        return

    ctx = get_pr_context()
    review = call_llm(
        system=(
            "You are a senior engineer doing code review. "
            "Be critical and specific. For each issue, state: "
            "FILE:LINE | SEVERITY (critical/major/minor) | DESCRIPTION | SUGGESTION\n\n"
            "Focus on:\n"
            "1. Logic errors and edge cases\n"
            "2. Security vulnerabilities (XSS, injection, secret leak)\n"
            "3. Error handling gaps\n"
            "4. Code style consistency with the codebase\n"
            "5. Performance issues\n\n"
            "If no issues, say 'No issues found.'"
        ),
        user=f"PR #{ctx['pr_num']} in {ctx['repo']}\n\n```diff\n{diff}\n```"
    )

    _write_output("review_body", review)
    with open("review.md", "w") as f:
        f.write(review)


def changelog_action():
    """Generate release notes from git log. Auto-detects previous tag."""
    prev_tag = os.getenv("PREV_TAG")
    if not prev_tag:
        # Auto-detect previous tag
        try:
            prev_tag = subprocess.run(
                ["git", "describe", "--tags", "--abbrev=0", "HEAD~1"],
                capture_output=True, text=True, check=True, timeout=10
            ).stdout.strip()
        except subprocess.CalledProcessError:
            prev_tag = None

    if prev_tag:
        log = subprocess.run(
            ["git", "log", f"{prev_tag}..HEAD", "--format=%h %s (%an, %ar)"],
            capture_output=True, text=True, check=True
        ).stdout
    else:
        log = subprocess.run(
            ["git", "log", "-30", "--format=%h %s (%an, %ar)"],
            capture_output=True, text=True, check=True
        ).stdout

    if not log.strip():
        print("No new commits since last release.")
        return

    notes = call_llm(
        system=(
            "Generate release notes from git log. t-cli is a Node.js CLI translator "
            "using DeepSeek API with Ink (React TUI). Group commits by:\n"
            "## Features — new capabilities\n"
            "## Bug Fixes — bug fixes and error handling\n"
            "## Refactoring — code quality, architecture\n"
            "## Docs — documentation changes\n\n"
            "For each group, list commits as bullet points with the commit hash in "
            "parentheses. If a group has no commits, omit it entirely.\n"
            "Output ONLY the release notes in valid markdown."
        ),
        user=f"Previous tag: {prev_tag or '(first release)'}\n\nCommits:\n{log}"
    )
    print(notes)


def auto_fix_action():
    """Fix failing CI tests. Reads logs, AI generates fix, commits and pushes."""
    run_id = os.getenv("FAILED_RUN_ID")
    if not run_id:
        print("::error::FAILED_RUN_ID not set")
        sys.exit(1)

    # 1. Get the PR diff (what code changed)
    diff = subprocess.run(
        ["git", "diff", "HEAD~1..HEAD", "--", ":!package-lock.json", ":!pnpm-lock.yaml"],
        capture_output=True, text=True, timeout=15
    ).stdout

    # 2. Get CI logs
    log = subprocess.run(
        ["gh", "run", "view", run_id, "--log"],
        capture_output=True, text=True, timeout=30
    ).stdout
    # Keep only the most relevant part (test output + errors)
    log_lines = log.split("\n")
    error_lines = [l for l in log_lines if "error" in l.lower() or "fail" in l.lower() or "assert" in l.lower() or "✖" in l or "×" in l]
    error_log = "\n".join(error_lines[-40:])  # last 40 error lines
    if len(error_log) < 50:
        error_log = log[-5000:]  # fallback: last 5k chars

    # 3. AI generates the fix
    fix = call_llm(
        system=(
            "You are a senior engineer fixing a CI test failure. "
            "The codebase is t-cli, a Node.js CLI translator using DeepSeek API "
            "with Ink (React TUI). Tests use Node.js built-in test runner (`node --test`).\n\n"
            "Rules:\n"
            "1. Fix the SOURCE CODE in src/, NEVER modify test files in test/\n"
            "2. Return ONLY the exact code change as a unified diff (git diff format)\n"
            "3. Be minimal — change only what's needed to pass the test\n"
            "4. If the issue is a missing null check / edge case, add the guard\n"
            "5. If you cannot determine the fix, output 'UNSURE: <reason>'"
        ),
        user=(
            f"CI Test Failure (run #{run_id}):\n\n"
            f"=== PR Diff (what changed) ===\n{diff[:5000]}\n\n"
            f"=== Error Log ===\n{error_log[:5000]}"
        )
    )

    if fix.startswith("UNSURE:"):
        print(f"AI could not determine fix: {fix}")
        sys.exit(0)

    # 4. Apply the fix
    result = subprocess.run(
        ["git", "apply", "--index"],
        input=fix, text=True, capture_output=True, timeout=15
    )
    if result.returncode != 0:
        print(f"::warning::git apply failed: {result.stderr[:500]}")
        result = subprocess.run(
            ["git", "apply", "--index", "--reject", "--whitespace=fix"],
            input=fix, text=True, capture_output=True, timeout=15
        )
        if result.returncode != 0:
            print(f"::warning::git apply (lenient) also failed: {result.stderr[:500]}")
            sys.exit(0)

    # 5. Configure git identity (runner may not have one)
    subprocess.run(["git", "config", "user.email", "ai-auto-fix[bot]@users.noreply.github.com"], capture_output=True)
    subprocess.run(["git", "config", "user.name", "AI Auto-Fix Bot"], capture_output=True)

    # 6. Check if anything changed
    status = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True).stdout
    if not status.strip():
        print("No changes to commit.")
        sys.exit(0)

    # 7. Commit and push
    branch = os.getenv("FIX_BRANCH") or os.getenv("GITHUB_HEAD_REF") or os.getenv("GITHUB_REF_NAME", "")
    subprocess.run(["git", "commit", "-m", "fix(ci): auto-fix CI failure [AI]"], check=False)
    push_result = subprocess.run(
        ["git", "push", "origin", f"HEAD:{branch}"],
        capture_output=True, text=True, timeout=30
    )
    if push_result.returncode == 0:
        print(f"✅ Auto-fix pushed to {branch}")
    else:
        print(f"::warning::Push failed: {push_result.stderr[:300]}")


def security_triage_action():
    """Analyze npm audit results, triage vulnerabilities, and create fix PR."""
    import json

    audit_file = os.getenv("AUDIT_FILE", "audit.json")
    if not os.path.exists(audit_file):
        print("::error::audit.json not found — did npm audit run?")
        sys.exit(1)

    with open(audit_file) as f:
        audit = json.load(f)

    vulnerabilities = audit.get("vulnerabilities", {})
    if not vulnerabilities:
        _write_output("summary", "No vulnerabilities found.")
        return

    # Categorize by severity
    critical = []
    high = []
    moderate = []
    low = []
    for pkg, info in vulnerabilities.items():
        sev = info.get("severity", "unknown")
        via = info.get("via", [])
        # via can be strings (advisory IDs) or objects
        advisory_info = []
        for v in via:
            if isinstance(v, dict):
                advisory_info.append(f"{v.get('title','')} — {v.get('cvss',{}).get('score','N/A')}")
            else:
                advisory_info.append(str(v))
        entry = {
            "package": pkg,
            "severity": sev,
            "range": info.get("range", ""),
            "fix_available": info.get("fixAvailable", False),
            "advisories": advisory_info[:3],
            "via_count": len(via),
        }
        if sev == "critical":
            critical.append(entry)
        elif sev == "high":
            high.append(entry)
        elif sev == "moderate":
            moderate.append(entry)
        else:
            low.append(entry)

    # AI analysis
    report = call_llm(
        system=(
            "You are a security engineer analyzing npm audit results for t-cli, "
            "a Node.js CLI translator. Summarize the vulnerabilities concisely:\n"
            "1. How many critical/high/moderate/low\n"
            "2. For each critical/high vulnerability: what is the risk, is a fix available\n"
            "3. Recommendation: run `npm audit fix` or manual upgrade\n\n"
            "If there are NO critical or high vulnerabilities, say 'No critical or high issues.'"
        ),
        user=(
            f"npm audit summary:\n"
            f"Total vulnerabilities: {audit['metadata']['vulnerabilities']['total']}\n"
            f"Critical: {len(critical)}, High: {len(high)}, "
            f"Moderate: {len(moderate)}, Low: {len(low)}\n\n"
            f"Details:\n{json.dumps({'critical': critical, 'high': high}, indent=2)}"
        )
    )

    has_critical = len(critical) > 0
    _write_output("summary", report)
    _write_output("has_critical", "true" if has_critical else "false")

    # Write a PR body if there are critical fixes
    if has_critical:
        pr_body = [
            "## AI Security Scan — Critical Vulnerabilities Found",
            "",
            report,
            "",
            "### Packages affected",
        ]
        for c in critical:
            pr_body.append(f"- **{c['package']}** ({c['severity']}): {c['range']}")
            for adv in c['advisories']:
                pr_body.append(f"  - {adv}")
        pr_body.append("")
        pr_body.append("---")
        pr_body.append("*Auto-generated by AI Security Scan workflow*")
        with open("security-fix-body.md", "w") as f:
            f.write("\n".join(pr_body))


def test_suggestion_action():
    """Suggest unit tests for new/modified code in a PR diff."""
    diff = get_diff()
    if not diff.strip():
        _write_output("suggestion", "No code changes to analyze.")
        return

    suggestion = call_llm(
        system=(
            "You are a testing expert reviewing a PR for t-cli, a Node.js CLI "
            "translator using Ink (React TUI). Tests use Node.js built-in test "
            "runner (`node --test`).\n\n"
            "For each new or modified function/class, suggest a unit test:\n"
            "1. What to test (function name + purpose)\n"
            "2. Key edge cases to cover\n"
            "3. Example test code snippet (concise, use `node:test` and `node:assert/strict`)\n\n"
            "Focus on the CHANGED code only. If no test-worthy changes exist, "
            "say 'No test-worthy changes detected.'"
        ),
        user=f"PR diff:\n```diff\n{diff[:8000]}\n```"
    )
    _write_output("suggestion", suggestion)
    # Also save to file for downstream Job readability    
    with open("suggestion.txt", "w") as f:
        f.write(suggestion)


def implement_issue_action():
    """Implement a feature described in an issue. Triggered by @coder comment."""
    import json, re

    issue_number = os.getenv("ISSUE_NUMBER")
    gh_token = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN")
    if not issue_number or not gh_token:
        print("::error::ISSUE_NUMBER and GH_TOKEN required")
        sys.exit(1)

    # ── 1. Get issue + comment context ──
    result = subprocess.run(
        ["gh", "issue", "view", issue_number,
         "--json", "title,body,labels,author,number"],
        capture_output=True, text=True, timeout=15
    )
    if result.returncode != 0:
        print(f"::error::gh issue view failed: {result.stderr}")
        sys.exit(1)
    issue = json.loads(result.stdout)
    issue_title = issue["title"]
    issue_body = issue.get("body") or "(no description)"
    print(f"Implementing issue #{issue_number}: {issue_title}")

    # ── 2. Get project structure ──
    structure = ""
    try:
        # Walk src/ directory to find exports
        src_lines = []
        for dirpath, dirs, files in os.walk("src"):
            dirs[:] = [d for d in dirs if not d.startswith("_")]
            for f in sorted(files):
                if f.endswith(".js"):
                    path = os.path.join(dirpath, f)
                    exports = set()
                    with open(path) as fh:
                        for line in fh:
                            m = re.match(r"export (?:function|const|class|default )?(\w+)", line)
                            if m:
                                exports.add(m.group(1))
                    label = ", ".join(sorted(exports)) if exports else "(no exports)"
                    src_lines.append(f"  {path}  -> exports: {label}")
        structure = "\n".join(src_lines)
    except Exception:
        structure = "(could not read structure)"

    # Also get entry point
    pkg_json = ""
    try:
        with open("package.json") as f:
            pkg = json.load(f)
            pkg_json = f"Entry: {pkg.get('bin', {})}\nDeps: {json.dumps(pkg.get('dependencies', {}), indent=2)}"
    except Exception:
        pkg_json = "(no package.json)"

    project_context = f"### Project Structure\n{structure}\n### Package\n{pkg_json}"

    # ── 3. AI Plans the implementation ──
    plan = call_llm(
        system=(
            "You are implementing a feature for t-cli, a Node.js CLI translator "
            "using DeepSeek API with Ink (React TUI). "
            "Analyze the issue and the existing codebase, then produce a JSON plan:\n\n"
            "{\n"
            '  "summary": "one-line description of what to build",\n'
            '  "files_to_create": ["src/utils/newfile.js"],\n'
            '  "files_to_modify": ["src/repl.js"],\n'
            '  "approach": "concise technical approach",\n'
            '  "test_changes": "describe what tests to add/modify"\n'
            "}\n\n"
            "Rules:\n"
            "- Keep changes minimal. Prefer adding new functions over modifying existing ones.\n"
            "- Only list files that actually need changes.\n"
            "- New utility functions go in src/utils/.\n"
            "- New commands go in src/repl.js.\n"
            "- Follow existing code patterns (JSDoc, export style, error handling)."
        ),
        user=(
            f"Issue #{issue_number}: {issue_title}\n\n"
            f"{issue_body[:3000]}\n\n"
            f"{project_context}"
        )
    )
    print(f"=== AI Plan ===\n{plan}\n")

    # Parse JSON from the plan (handle nested objects and markdown-wrapped output)
    try:
        # Try to extract JSON from markdown code block first
        json_block = re.search(r'```(?:json)?\s*([\s\S]*?)```', plan)
        plan_str = json_block.group(1) if json_block else plan
        # Find the outermost JSON object
        brace_start = plan_str.index("{")
        brace_depth = 0
        brace_end = -1
        for i in range(brace_start, len(plan_str)):
            if plan_str[i] == "{":
                brace_depth += 1
            elif plan_str[i] == "}":
                brace_depth -= 1
                if brace_depth == 0:
                    brace_end = i + 1
                    break
        if brace_end > brace_start:
            plan_str = plan_str[brace_start:brace_end]
        else:
            raise ValueError("No matching closing brace found")

        parsed = json.loads(plan_str)
        files_to_create = parsed.get("files_to_create", [])
        files_to_modify = parsed.get("files_to_modify", [])
        approach = parsed.get("approach", "No approach specified")
    except (json.JSONDecodeError, AttributeError) as e:
        print(f"::warning::Could not parse plan JSON: {e}")
        print(f"Raw plan:\n{plan}")
        # Fallback: treat the whole plan as approach
        files_to_create = []
        files_to_modify = []
        approach = plan[:500]

    # ── 4. Generate implementation code per file ──
    all_files = files_to_create + files_to_modify
    if not all_files:
        # AI didn't specify files; ask what to generate
        print("No files specified in plan, generating single implementation...")

    changes_made = []
    for filepath in all_files:
        existing_code = ""
        existing_context = "(new file)"
        if filepath in files_to_modify:
            try:
                with open(filepath) as f:
                    existing_code = f.read()
                existing_context = f"Existing code:\n```\n{existing_code[:5000]}\n```"
            except FileNotFoundError:
                existing_code = "(file does not exist yet)"
                existing_context = "(new file)"
                files_to_create.append(filepath)

        code = call_llm(
            system=(
                "Generate the implementation code for this file in t-cli. "
                "Output ONLY the complete file content inside a code block.\n\n"
                "Rules:\n"
                "- Use ES module syntax (import/export)\n"
                "- Include JSDoc comments for all exports\n"
                "- Handle edge cases and null inputs\n"
                "- Follow existing code style (error handling, logging, naming)\n"
                "- If modifying an existing file, output the ENTIRE updated file"
            ),
            user=(
                f"Issue: {issue_title}\n\n"
                f"Approach: {approach}\n\n"
                f"File: {filepath}\n"
                f"{existing_context}"
            )
        )

        # Extract code block content
        code_match = re.search(r'```(?:javascript|js|)?\n([\s\S]*?)\n```', code)
        final_code = code_match.group(1) if code_match else code

        # Ensure directory exists
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w") as f:
            f.write(final_code)
        changes_made.append(filepath)
        print(f"  ✓ {filepath} {'created' if filepath in files_to_create else 'updated'}")

    if not changes_made:
        print("::warning::No files were changed. Skipping PR creation.")
        sys.exit(0)

    # ── 5. Create branch and push changes ──
    branch = f"ai/issue-{issue_number}"
    subprocess.run(["git", "config", "user.email", "ai-coder[bot]@users.noreply.github.com"],
                   capture_output=True)
    subprocess.run(["git", "config", "user.name", "AI Coder Bot"], capture_output=True)

    subprocess.run(["git", "checkout", "-b", branch], capture_output=True)
    subprocess.run(["git", "add", "-A"], capture_output=True)

    commit_result = subprocess.run(
        ["git", "commit", "-m", f"feat: implement #{issue_number} - {issue_title[:60]}"],
        capture_output=True, text=True
    )
    if commit_result.returncode != 0:
        print(f"::warning::Commit failed: {commit_result.stderr[:300]}")
        sys.exit(0)

    print(f"  ✓ Changes committed locally on branch: {branch}")

    # Push the branch using the origin remote with stored credentials
    gh_token = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN", "")
    prefix = gh_token[:8] if len(gh_token) > 8 else "short"
    print(f"  Token prefix: {prefix}...")
    # First ensure the remote URL has a valid token
    subprocess.run(
        ["git", "config", "--local", "credential.helper", ""],
        capture_output=True
    )
    # Set the remote to use GH_TOKEN directly (from env)
    repo = os.getenv("GITHUB_REPOSITORY", "")
    remote_with_token = f"https://{gh_token}@github.com/{repo}.git"
    subprocess.run(
        ["git", "remote", "set-url", "origin", remote_with_token],
        capture_output=True
    )
    push_result = subprocess.run(
        f"git push -v origin HEAD:{branch} 2>&1",
        capture_output=True, text=True, timeout=30, shell=True
    )
    if push_result.returncode != 0:
        print(f"::warning::Push failed (exit={push_result.returncode})")
        print(f"::warning::stderr: {push_result.stderr.strip()[-500:]}")
        print(f"::warning::stdout: {push_result.stdout.strip()[-500:]}")
        sys.exit(0)
    print(f"  ✓ Branch pushed: {branch}")

    # Write PR body to file for downstream action
    pr_body = (
        f"## AI-Generated Implementation\n\n"
        f"This PR implements **{issue_title}**\n\n"
        f"### Issue\n"
        f"Closes #{issue_number}\n\n"
        f"### Approach\n{approach}\n\n"
        f"### Files Changed\n" +
        "\n".join(f"- {f}" for f in changes_made) +
        "\n\n---\n*🤖 Generated by @coder \u2014 please review before merging*"
    )
    with open("pr-body.md", "w") as f:
        f.write(pr_body)

    print(f"Branch ready: {branch}")
    _write_output("branch", branch)
    _write_output("pr_title", f"feat: {issue_title[:80]}")
    _write_output("pr_body_path", "pr-body.md")


def issue_triage_action():
    """Scan open issues, AI classifies and applies labels."""
    import json, re

    gh_token = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN")
    if not gh_token:
        print("::error::GH_TOKEN not set")
        sys.exit(1)

    # 1. Ensure needed labels exist in the repo
    NEEDED_LABELS = {
        "bug": {"color": "d73a4a", "desc": "Something isn't working"},
        "feature": {"color": "a2eeef", "desc": "New feature or request"},
        "enhancement": {"color": "a2eeef", "desc": "New feature or request"},
        "question": {"color": "d876e3", "desc": "Further information is requested"},
        "docs": {"color": "0075ca", "desc": "Documentation changes"},
        "refactor": {"color": "bfdadc", "desc": "Code refactoring"},
        "priority:critical": {"color": "b60205", "desc": "Critical priority"},
        "priority:high": {"color": "d73a4a", "desc": "High priority"},
    }
    existing_labels = set()
    result = subprocess.run(
        ["gh", "label", "list", "--limit", "50"],
        capture_output=True, text=True, timeout=15
    )
    if result.returncode == 0:
        for line in result.stdout.strip().split("\n"):
            name = line.split("\t")[0] if "\t" in line else line.split()[0] if line else ""
            if name:
                existing_labels.add(name)

    for name, cfg in NEEDED_LABELS.items():
        if name not in existing_labels:
            subprocess.run(
                ["gh", "label", "create", name,
                 "--color", cfg["color"],
                 "--description", cfg["desc"]],
                capture_output=True, timeout=10
            )
            print(f"  Created label: {name}")

    # Map AI types to actual label names
    TYPE_LABEL_MAP = {
        "bug": "bug",
        "feature": "feature",
        "question": "question",
        "docs": "docs",
        "refactor": "refactor",
    }

    # 2. Fetch open issues
    result = subprocess.run(
        ["gh", "issue", "list", "--state", "open", "--limit", "20",
         "--json", "number,title,body,labels,createdAt,comments"],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print(f"::error::gh issue list failed: {result.stderr}")
        sys.exit(1)

    issues = json.loads(result.stdout)
    if not issues:
        _write_output("report", "No open issues to triage.")
        return

    # 2. AI classifies each issue
    for issue in issues:
        existing_labels = [l["name"] for l in issue.get("labels", [])]
        # Skip already-triaged issues (have type labels)
        if any(l in ["bug", "feature", "enhancement", "question", "docs"] for l in existing_labels):
            continue

        analysis = call_llm(
            system=(
                "Classify this GitHub issue for t-cli, a Node.js CLI translator. "
                "Return ONLY a JSON object with:\n"
                "{\n"
                '  "type": "bug|feature|question|docs|refactor",\n'
                '  "priority": "critical|high|medium|low",\n'
                '  "summary": "one-line summary (max 80 chars)"\n'
                "}\n"
                "Base the type and priority on the issue content."
            ),
            user=f"Issue #{issue['number']}: {issue['title']}\n\n{issue['body'][:2000] or '(no description)'}"
        )

        try:
            # Extract JSON from response (handle markdown-wrapped output)
            json_match = re.search(r'\{[^}]+\}', analysis, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
            else:
                parsed = json.loads(analysis)

            issue_type = parsed.get("type", "question")
            priority = parsed.get("priority", "medium")

            # Map to GitHub labels using TYPE_LABEL_MAP
            labels_to_add = [TYPE_LABEL_MAP.get(issue_type, issue_type)]
            if priority in ("critical", "high"):
                labels_to_add.append("priority:" + priority)

            subprocess.run(
                ["gh", "issue", "edit", str(issue["number"]),
                 "--add-label", ",".join(labels_to_add)],
                capture_output=True, timeout=15
            )
            print(f"Issue #{issue['number']}: {issue_type}/{priority} → labels: {labels_to_add}")

        except (json.JSONDecodeError, KeyError) as e:
            print(f"::warning::Issue #{issue['number']}: parse error: {e}, raw: {analysis[:200]}")

    _write_output("report", f"Triaged {len(issues)} issues.")


def summary_action():
    """Summarize an issue body."""
    body = os.getenv("ISSUE_BODY", "")
    summary = call_llm(
        system="Summarize this issue: what is the problem, where does it occur, any proposed solution.",
        user=body
    )
    print(summary)


def main():
    action = os.getenv("AI_ACTION", "review")

    if action == "review":
        review_action()
    elif action == "changelog":
        changelog_action()
    elif action == "auto_fix":
        auto_fix_action()
    elif action == "security_triage":
        security_triage_action()
    elif action == "issue_triage":
        issue_triage_action()
    elif action == "test_suggestion":
        test_suggestion_action()
    elif action == "implement_issue":
        implement_issue_action()
    elif action == "summary":
        summary_action()
    else:
        print(f"::error::Unknown action: {action}")
        sys.exit(1)


if __name__ == "__main__":
    main()
