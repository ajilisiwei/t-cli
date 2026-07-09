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
    elif action == "summary":
        summary_action()
    else:
        print(f"::error::Unknown action: {action}")
        sys.exit(1)


if __name__ == "__main__":
    main()
