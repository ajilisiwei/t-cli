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


def issue_triage_action():
    """Scan open issues, AI classifies and applies labels."""
    import json, re

    gh_token = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN")
    if not gh_token:
        print("::error::GH_TOKEN not set")
        sys.exit(1)

    # 1. Fetch open issues with no labels (untriaged)
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

            # Map to GitHub labels
            labels_to_add = [issue_type]
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
    elif action == "summary":
        summary_action()
    else:
        print(f"::error::Unknown action: {action}")
        sys.exit(1)


if __name__ == "__main__":
    main()
