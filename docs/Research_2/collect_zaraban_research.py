#!/usr/bin/env python3
"""
Build a local research corpus for Zaraban.

This script intentionally avoids installing dependencies, building projects, or
executing code from cloned repositories. It only uses git/GitHub metadata,
filesystem reads, and HTTP fetches for research artifacts.
"""

from __future__ import annotations

import datetime as dt
import html
import html.parser
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ROOT = Path.home() / "zaraban-research"
REPOS_ROOT = ROOT / "repos"
EXTRACTED_ROOT = ROOT / "extracted"
WEB_ROOT = ROOT / "web-research"
SUMMARY_ROOT = ROOT / "summary"
NOTES = ROOT / "NOTES.md"
MANIFEST = ROOT / "MANIFEST.md"

NOW = dt.datetime.now(dt.timezone.utc)
STALE_DAYS = 180
ACTIVE_DAYS = 90
MAX_COPY_BYTES = 1_500_000
MAX_TOOL_FILES = 80
MAX_PROMPT_FILES = 80
MAX_EDIT_FILES = 80

CATEGORY_DIRS = [
    "coding-agents",
    "agent-frameworks",
    "memory-systems",
    "browser-agents",
    "mcp-servers",
    "system-prompt-leaks",
    "edit-format-implementations",
    "sandbox-runtimes",
    "vision-multimodal",
    "eval-harnesses",
]


@dataclass
class RepoTarget:
    url: str
    category: str
    tier: str = "tier1"
    note: str = ""
    clone_path: Path | None = None
    extracted_path: Path | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    extracted_files: list[str] = field(default_factory=list)
    key_files: dict[str, list[tuple[str, str]]] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


TIER1_TARGETS = [
    RepoTarget("https://github.com/Aider-AI/aider", "coding-agents"),
    RepoTarget("https://github.com/cline/cline", "coding-agents"),
    RepoTarget("https://github.com/OpenHands/OpenHands", "coding-agents"),
    RepoTarget("https://github.com/OpenHands/software-agent-sdk", "agent-frameworks"),
    RepoTarget("https://github.com/openai/codex", "coding-agents"),
    RepoTarget("https://github.com/google-gemini/gemini-cli", "coding-agents"),
    RepoTarget("https://github.com/sst/opencode", "coding-agents", note="verify exact org"),
    RepoTarget("https://github.com/continuedev/continue", "coding-agents", note="canonical org verified from local remote"),
    RepoTarget("https://github.com/block/goose", "coding-agents"),
    RepoTarget("https://github.com/Kilo-Org/kilocode", "coding-agents"),
    RepoTarget("https://github.com/RooCodeInc/Roo-Code", "coding-agents", note="verify exact org"),
    RepoTarget("https://github.com/NousResearch/hermes-agent", "coding-agents"),
    RepoTarget("https://github.com/Piebald-AI/claude-code-system-prompts", "system-prompt-leaks"),
    RepoTarget("https://github.com/asgeirtj/system_prompts_leaks", "system-prompt-leaks"),
    RepoTarget("https://github.com/letta-ai/letta", "memory-systems"),
    RepoTarget("https://github.com/mem0ai/mem0", "memory-systems"),
    RepoTarget("https://github.com/topoteretes/cognee", "memory-systems"),
    RepoTarget("https://github.com/getzep/zep", "memory-systems", note="verify"),
    RepoTarget("https://github.com/kingjulio8238/Memary", "memory-systems", note="verify"),
    RepoTarget("https://github.com/browser-use/browser-use", "browser-agents"),
    RepoTarget("https://github.com/Skyvern-AI/skyvern", "browser-agents"),
    RepoTarget("https://github.com/microsoft/playwright-mcp", "browser-agents"),
    RepoTarget("https://github.com/browserbase/stagehand", "browser-agents"),
    RepoTarget("https://github.com/wong2/awesome-mcp-servers", "mcp-servers"),
    RepoTarget("https://github.com/just-every/mcp-read-website-fast", "mcp-servers"),
    RepoTarget("https://github.com/just-every/mcp-screenshot-website-fast", "mcp-servers"),
    RepoTarget("https://github.com/stabgan/openrouter-mcp-multimodal", "mcp-servers"),
    RepoTarget("https://github.com/ifmelate/mcp-image-extractor", "mcp-servers"),
    RepoTarget("https://github.com/e2b-dev/e2b", "sandbox-runtimes"),
    RepoTarget("https://github.com/modal-labs/modal-client", "sandbox-runtimes", note="verify relevance"),
    RepoTarget("https://github.com/daytonaio/daytona", "sandbox-runtimes"),
    RepoTarget("https://github.com/princeton-nlp/SWE-bench", "eval-harnesses"),
    RepoTarget("https://github.com/laude-institute/terminal-bench", "eval-harnesses", note="verify"),
    RepoTarget("https://github.com/livebench/livebench", "eval-harnesses"),
]

TIER2_QUERIES = [
    '"agentic coding" language:TypeScript stars:>5000',
    '"agentic coding" language:Rust stars:>5000',
    '"ai coding agent" stars:>5000',
    '"claude code" -in:name stars:>5000',
    '"mcp server" stars:>5000',
    '"agent harness" stars:>5000',
    '"tool use loop" stars:>5000',
    '"agent memory" stars:>5000',
    '"code editing agent" stars:>5000',
    '"browser agent" stars:>5000',
]

WEB_TARGETS = {
    "claude-code-leak": [
        "https://www.dbreunig.com/2026/04/04/how-claude-code-builds-a-system-prompt.html",
        "https://www.mindstudio.ai/blog/claude-code-source-code-leak-8-hidden-features",
        "https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/",
        "https://aiia.ro/blog/claude-code-system-prompt-leaked/",
    ],
    "cursor-architecture": [
        "https://fabianhertwig.com/blog/coding-assistants-file-edits/",
        "https://www.cursor.com/blog",
        "https://www.cursor.com/blog/instant-apply",
        "https://www.cursor.com/blog/fast-apply",
    ],
    "blog-posts": [
        "https://www.anthropic.com/engineering/building-effective-agents",
        "https://www.anthropic.com/engineering",
        "https://docs.anthropic.com/en/docs/claude-code/skills",
        "https://aider.chat/blog/",
        "https://www.all-hands.dev/blog",
        "https://blog.langchain.com/",
        "https://mem0.ai/blog",
        "https://www.letta.com/blog",
        "https://www.cognee.ai/blog",
    ],
    "codex-internals": [
        "https://github.com/openai/codex",
        "https://openai.com/index/introducing-codex/",
        "https://openai.com/codex/",
    ],
}

PAPER_QUERIES = [
    ("openhands-sdk-2511.03690", "2511.03690"),
    ("memgpt", 'ti:"MemGPT"'),
    ("mem0", 'ti:"Mem0"'),
    ("a-mem", 'ti:"A-MEM" OR ti:"agent memory"'),
    ("reflexion", 'ti:"Reflexion"'),
    ("react", 'ti:"ReAct" AND ti:"reasoning"'),
    ("toolformer", 'ti:"Toolformer"'),
    ("swe-bench", 'ti:"SWE-bench"'),
    ("voyager", 'ti:"Voyager" AND ti:"Minecraft"'),
    ("generative-agents", 'ti:"Generative Agents"'),
    ("agentic-coding-2025-2026", 'ti:"agentic coding" OR ti:"coding agent"'),
    ("long-horizon-agent-2025-2026", 'ti:"long-horizon agent" OR ti:"long horizon agent"'),
    ("agent-memory-2025-2026", 'ti:"agent memory" OR ti:"memory agents"'),
]

WEAK_AREAS = [
    "patch_file edit reliability on Gemma 4",
    "Decomposition over-splitting",
    "JSON schema surface area at LLM call sites",
    "Internet/download/vision capabilities",
    "Heartbeat / idle background process",
    "Browser control",
    "UI transparency display human-readability",
    "WebSocket reliability under long streams",
]


def log(message: str) -> None:
    timestamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    NOTES.parent.mkdir(parents=True, exist_ok=True)
    with NOTES.open("a", encoding="utf-8") as f:
        f.write(f"- {timestamp}: {message}\n")
    print(message, flush=True)


def run(args: list[str], cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=str(cwd) if cwd else None, text=True, capture_output=True, timeout=timeout)


def safe_name_from_url(url: str) -> str:
    return url.rstrip("/").split("/")[-1].replace(".git", "")


def owner_repo_from_url(url: str) -> tuple[str, str] | None:
    m = re.match(r"https://github\.com/([^/]+)/([^/#?]+)", url.rstrip("/"))
    if not m:
        return None
    return m.group(1), m.group(2).replace(".git", "")


def ensure_structure() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for d in CATEGORY_DIRS:
        (REPOS_ROOT / d).mkdir(parents=True, exist_ok=True)
    for d in ["claude-code-leak", "codex-internals", "cursor-architecture", "blog-posts", "papers"]:
        (WEB_ROOT / d).mkdir(parents=True, exist_ok=True)
    SUMMARY_ROOT.mkdir(parents=True, exist_ok=True)
    if not NOTES.exists():
        NOTES.write_text("# Zaraban Research Notes\n\n", encoding="utf-8")


def gh_api(path_or_url: str, params: dict[str, str] | None = None) -> tuple[int, Any, str | None]:
    url = path_or_url if path_or_url.startswith("http") else f"https://api.github.com/{path_or_url.lstrip('/')}"
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    gh = shutil.which("gh")
    if gh:
        proc = run([gh, "api", url], timeout=120)
        if proc.returncode == 0:
            try:
                return 200, json.loads(proc.stdout), url
            except json.JSONDecodeError:
                return 200, proc.stdout, url
        if "HTTP 404" in proc.stderr:
            return 404, None, url
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "zaraban-research"})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8")), resp.geturl()
    except urllib.error.HTTPError as e:
        return e.code, None, url
    except Exception as e:
        return 0, None, f"{url} ERROR {e}"


def fetch_url(url: str, timeout: int = 60) -> tuple[int, bytes, str, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 zaraban-research"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content_type = resp.headers.get("content-type", "")
            return resp.status, resp.read(), resp.geturl(), content_type
    except urllib.error.HTTPError as e:
        if e.code in {301, 302, 303, 307, 308}:
            location = e.headers.get("Location") if e.headers else None
            if location:
                redirected = urllib.parse.urljoin(url, location)
                if redirected != url:
                    return fetch_url(redirected, timeout=timeout)
        return e.code, e.read()[:2000], url, e.headers.get("content-type", "") if e.headers else ""
    except Exception as e:
        return 0, str(e).encode("utf-8", "replace"), url, ""


def resolve_repo_metadata(target: RepoTarget) -> dict[str, Any]:
    info = owner_repo_from_url(target.url)
    if not info:
        target.errors.append("not a GitHub URL")
        return {}
    status, data, final = gh_api(f"repos/{info[0]}/{info[1]}")
    if status != 200 or not isinstance(data, dict):
        target.errors.append(f"GitHub metadata fetch failed: status={status} url={final}")
        log(f"Metadata failed for {target.url}: status={status}")
        return {}
    canonical = data.get("html_url") or target.url
    license_obj = data.get("license") or {}
    meta = {
        "name": data.get("name") or safe_name_from_url(target.url),
        "full_name": data.get("full_name"),
        "url": canonical,
        "requested_url": target.url,
        "stars": data.get("stargazers_count"),
        "forks": data.get("forks_count"),
        "pushed_at": data.get("pushed_at"),
        "updated_at": data.get("updated_at"),
        "created_at": data.get("created_at"),
        "license": license_obj.get("spdx_id") or "NOASSERTION",
        "license_name": license_obj.get("name") if license_obj else None,
        "language": data.get("language") or "Unknown",
        "description": data.get("description") or "",
        "archived": data.get("archived"),
        "default_branch": data.get("default_branch"),
        "canonical_url": canonical,
        "metadata_status": status,
    }
    if canonical.rstrip("/") != target.url.rstrip("/"):
        meta["redirected_from"] = target.url
        target.url = canonical
        log(f"Canonical URL for {info[0]}/{info[1]} is {canonical}")
    target.metadata.update(meta)
    return meta


def discover_tier2(existing_urls: set[str]) -> list[RepoTarget]:
    found: list[RepoTarget] = []
    cutoff = NOW - dt.timedelta(days=ACTIVE_DAYS)
    for query in TIER2_QUERIES:
        q = f"{query} pushed:>{cutoff.date().isoformat()}"
        status, data, final = gh_api("search/repositories", {"q": q, "sort": "stars", "order": "desc", "per_page": "10"})
        if status != 200 or not isinstance(data, dict):
            log(f"Tier 2 search failed for {query}: status={status} url={final}")
            continue
        for item in data.get("items", []):
            url = item.get("html_url")
            if not url or url in existing_urls:
                continue
            if (item.get("stargazers_count") or 0) < 5000:
                continue
            pushed = parse_date(item.get("pushed_at"))
            if pushed and pushed < cutoff:
                continue
            category = classify_repo(url, item.get("name", ""), item.get("description", ""))
            target = RepoTarget(url, category, tier="tier2", note=f"discovered via {query}")
            target.metadata.update(
                {
                    "name": item.get("name"),
                    "full_name": item.get("full_name"),
                    "url": url,
                    "requested_url": url,
                    "stars": item.get("stargazers_count"),
                    "forks": item.get("forks_count"),
                    "pushed_at": item.get("pushed_at"),
                    "license": (item.get("license") or {}).get("spdx_id") or "NOASSERTION",
                    "language": item.get("language") or "Unknown",
                    "description": item.get("description") or "",
                    "archived": item.get("archived"),
                    "canonical_url": url,
                }
            )
            existing_urls.add(url)
            found.append(target)
        time.sleep(1)
    log(f"Discovered {len(found)} Tier 2 candidates after filters")
    return found


def dedupe_targets(targets: list[RepoTarget]) -> list[RepoTarget]:
    seen: set[str] = set()
    deduped: list[RepoTarget] = []
    for target in targets:
        key = normalize_git_remote(str(target.metadata.get("canonical_url") or target.metadata.get("url") or target.url))
        if key in seen:
            log(f"Skipping duplicate target in manifest set: {key}")
            continue
        seen.add(key)
        deduped.append(target)
    return deduped


def classify_repo(url: str, name: str, desc: str) -> str:
    text = f"{url} {name} {desc}".lower()
    if any(x in text for x in ["browser", "playwright", "stagehand", "skyvern"]):
        return "browser-agents"
    if any(x in text for x in ["memory", "mem0", "memgpt", "zep", "cognee"]):
        return "memory-systems"
    if "mcp" in text:
        return "mcp-servers"
    if any(x in text for x in ["bench", "eval", "harness"]):
        return "eval-harnesses"
    if any(x in text for x in ["sandbox", "e2b", "modal", "daytona"]):
        return "sandbox-runtimes"
    return "coding-agents"


def parse_date(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def clone_repo(target: RepoTarget) -> None:
    name = target.metadata.get("name") or safe_name_from_url(target.url)
    clone_path = REPOS_ROOT / target.category / name
    target.clone_path = clone_path
    if clone_path.exists() and (clone_path / ".git").exists():
        log(f"Repo already present, fetching metadata/extracting: {name}")
        return
    if clone_path.exists():
        target.warnings.append(f"Path exists but is not a git repo: {clone_path}")
        return
    clone_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["git", "clone", "--depth=50", "--single-branch", target.url, str(clone_path)]
    proc = run(cmd, timeout=2400)
    if proc.returncode != 0:
        target.errors.append(f"git clone failed: {proc.stderr.strip()[:500]}")
        log(f"Clone failed for {target.url}: {proc.stderr.strip()[:220]}")
    else:
        log(f"Cloned {target.url}")


def normalize_git_remote(remote: str) -> str:
    remote = remote.strip()
    if remote.startswith("git@github.com:"):
        remote = "https://github.com/" + remote.split(":", 1)[1]
    if remote.endswith(".git"):
        remote = remote[:-4]
    return remote.rstrip("/")


def include_existing_local_repos(targets: list[RepoTarget]) -> list[RepoTarget]:
    known_paths = {t.clone_path.resolve() for t in targets if t.clone_path}
    known_urls = {
        normalize_git_remote(str(t.metadata.get("canonical_url") or t.metadata.get("url") or t.url))
        for t in targets
    }
    extras: list[RepoTarget] = []
    for category_dir in REPOS_ROOT.iterdir() if REPOS_ROOT.exists() else []:
        if not category_dir.is_dir():
            continue
        for repo_dir in category_dir.iterdir():
            if not (repo_dir / ".git").exists() or repo_dir.resolve() in known_paths:
                continue
            proc = run(["git", "-C", str(repo_dir), "config", "--get", "remote.origin.url"], timeout=30)
            if proc.returncode != 0:
                continue
            url = normalize_git_remote(proc.stdout)
            if url in known_urls:
                log(f"Local duplicate clone remains outside manifest target set: {repo_dir}")
                continue
            target = RepoTarget(
                url=url,
                category=category_dir.name,
                tier="local-existing",
                note="Found in repos/ during verification; indexed to keep corpus coherent",
                clone_path=repo_dir,
            )
            resolve_repo_metadata(target)
            extras.append(target)
            known_paths.add(repo_dir.resolve())
            known_urls.add(normalize_git_remote(target.metadata.get("canonical_url") or url))
    if extras:
        log(f"Indexed {len(extras)} existing local repos not returned by the latest Tier 2 search")
    return extras


def assign_unique_output_names(targets: list[RepoTarget]) -> None:
    counts: dict[str, int] = {}
    for target in targets:
        name = str(target.metadata.get("name") or safe_name_from_url(target.url))
        counts[name] = counts.get(name, 0) + 1
    for target in targets:
        name = str(target.metadata.get("name") or safe_name_from_url(target.url))
        if counts.get(name, 0) > 1:
            full_name = str(target.metadata.get("full_name") or f"{target.category}/{name}")
            unique = re.sub(r"[^A-Za-z0-9_.-]+", "__", full_name)
            target.metadata["extracted_name"] = unique
            target.metadata["manifest_name"] = full_name
        else:
            target.metadata["extracted_name"] = name
            target.metadata["manifest_name"] = name


def is_text_candidate(path: Path) -> bool:
    if path.is_dir() or path.stat().st_size > MAX_COPY_BYTES:
        return False
    if ".git" in path.parts:
        return False
    return True


def copy_file(src: Path, dst: Path, target: RepoTarget, warning_prefix: str | None = None) -> bool:
    try:
        if not is_text_candidate(src):
            return False
        dst.parent.mkdir(parents=True, exist_ok=True)
        if warning_prefix and src.name.lower().startswith("readme"):
            content = src.read_text(encoding="utf-8", errors="replace")
            dst.write_text(warning_prefix + "\n\n" + content, encoding="utf-8")
        else:
            shutil.copy2(src, dst)
        target.extracted_files.append(str(dst.relative_to(ROOT)))
        return True
    except Exception as e:
        target.warnings.append(f"copy failed {src}: {e}")
        return False


def find_readme(repo: Path) -> Path | None:
    for name in ["README.md", "Readme.md", "readme.md", "README.rst", "README.txt"]:
        p = repo / name
        if p.exists() and p.is_file():
            return p
    matches = sorted(repo.glob("README*"))
    return matches[0] if matches else None


def relative_safe_name(path: Path, root: Path) -> str:
    rel = path.relative_to(root).as_posix()
    return rel.replace("/", "__")


def walk_files(repo: Path) -> list[Path]:
    skip_dirs = {".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next", ".cache"}
    files: list[Path] = []
    for base, dirs, names in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".turbo")]
        for name in names:
            path = Path(base) / name
            try:
                if path.is_file():
                    files.append(path)
            except OSError:
                continue
    return files


def extension_language(path: Path) -> str | None:
    ext = path.suffix.lower()
    return {
        ".ts": "TypeScript",
        ".tsx": "TypeScript",
        ".js": "JavaScript",
        ".jsx": "JavaScript",
        ".py": "Python",
        ".rs": "Rust",
        ".go": "Go",
        ".java": "Java",
        ".kt": "Kotlin",
        ".md": "Markdown",
        ".mdx": "Markdown",
        ".json": "JSON",
        ".yml": "YAML",
        ".yaml": "YAML",
        ".toml": "TOML",
        ".sh": "Shell",
    }.get(ext)


def compute_primary_language(files: list[Path]) -> str:
    counts: dict[str, int] = {}
    for p in files:
        lang = extension_language(p)
        if not lang:
            continue
        try:
            counts[lang] = counts.get(lang, 0) + p.stat().st_size
        except OSError:
            pass
    if not counts:
        return "Unknown"
    return sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[0][0]


def top_level_tree(repo: Path) -> str:
    lines: list[str] = []
    for child in sorted(repo.iterdir(), key=lambda p: p.name.lower()):
        if child.name == ".git":
            continue
        if child.is_dir():
            lines.append(f"{child.name}/")
            try:
                subdirs = [p.name + "/" for p in sorted(child.iterdir(), key=lambda p: p.name.lower()) if p.is_dir() and p.name != ".git"]
                for sub in subdirs[:20]:
                    lines.append(f"  {sub}")
            except OSError:
                pass
    return "\n".join(lines[:250])


def file_contains_any(path: Path, words: list[str]) -> bool:
    text = path.as_posix().lower()
    if any(w in text for w in words):
        return True
    if path.stat().st_size > 500_000:
        return False
    try:
        chunk = path.read_text(encoding="utf-8", errors="replace").lower()[:500_000]
    except Exception:
        return False
    return any(w in chunk for w in words)


def extract_repo(target: RepoTarget) -> None:
    repo = target.clone_path
    if not repo or not repo.exists() or not (repo / ".git").exists():
        return
    name = target.metadata.get("extracted_name") or target.metadata.get("name") or repo.name
    out = EXTRACTED_ROOT / name
    target.extracted_path = out
    out.mkdir(parents=True, exist_ok=True)
    files = walk_files(repo)
    target.metadata["primary_language_by_bytes"] = compute_primary_language(files)
    target.metadata["top_level_tree_L2_dirs"] = top_level_tree(repo)
    target.metadata["local_path"] = str(repo)
    target.metadata["extracted_path"] = str(out)
    target.metadata["tier"] = target.tier
    target.metadata["category"] = target.category
    target.metadata["notes"] = target.note

    license_warning = None
    license_spdx = (target.metadata.get("license") or "").upper()
    if "GPL" in license_spdx or "AGPL" in license_spdx:
        license_warning = f"**LICENSE WARNING:** This repository is {license_spdx}. Manual legal review is required before adopting code."
        target.warnings.append(license_warning)

    readme = find_readme(repo)
    if readme:
        copy_file(readme, out / "README.md", target, license_warning)
        target.metadata["readme_non_empty"] = readme.stat().st_size > 0
    else:
        target.errors.append("README not found")
        target.metadata["readme_non_empty"] = False

    arch_matches: list[Path] = []
    prompt_matches: list[Path] = []
    tool_matches: list[Path] = []
    edit_matches: list[Path] = []
    model_matches: list[Path] = []

    for p in files:
        try:
            rel = p.relative_to(repo).as_posix()
            low = rel.lower()
            name_low = p.name.lower()
            if not is_text_candidate(p):
                continue
            if (
                name_low.startswith(("architecture", "design", "internals", "model"))
                or "/docs/architecture/" in low
                or "/docs/design/" in low
            ):
                arch_matches.append(p)
            if (
                re.search(r"(^|/)prompts?/.*\.(md|txt|ts|tsx|js|py|rs)$", low)
                or "system_prompt" in low
                or "system-prompt" in low
                or "systemprompt" in low
            ):
                prompt_matches.append(p)
            if re.search(r"(^|/)(tools?|skills?)/.*\.(ts|tsx|py|js|rs|md)$", low):
                tool_matches.append(p)
            if (
                re.search(r"(edit|patch|diff|udiff|whole.?file|search.?replace)", low)
                and p.suffix.lower() in {".ts", ".tsx", ".py", ".js", ".rs", ".md"}
            ):
                edit_matches.append(p)
            if "model" in low and p.suffix.lower() in {".md", ".ts", ".py", ".js", ".rs"}:
                model_matches.append(p)
            if repo.name.lower() == "aider" and re.search(r"(^|/)coders/.*\.py$", low):
                edit_matches.append(p)
        except Exception:
            continue

    copy_collection(repo, out, "ARCHITECTURE_FILES", arch_matches[:80], target)
    copy_collection(repo, out, "PROMPTS", prompt_matches[:MAX_PROMPT_FILES], target)
    copy_collection(repo, out, "TOOLS", tool_matches[:MAX_TOOL_FILES], target)
    copy_collection(repo, out, "EDIT_FORMATS", unique_paths(edit_matches)[:MAX_EDIT_FILES], target)

    if arch_matches:
        write_combined_architecture(repo, out / "ARCHITECTURE.md", arch_matches[:20], target)
    else:
        (out / "ARCHITECTURE.md").write_text("# Architecture\n\nNo dedicated architecture/design/internal docs found by heuristic.\n", encoding="utf-8")
        target.extracted_files.append(str((out / "ARCHITECTURE.md").relative_to(ROOT)))

    identify_key_files(repo, files, out / "KEY_FILES.md", target)
    target.metadata["extraction_counts"] = {
        "architecture": len(arch_matches),
        "prompts": len(prompt_matches),
        "tools": len(tool_matches),
        "edit_formats": len(unique_paths(edit_matches)),
        "model_docs_or_code": len(model_matches),
    }
    target.metadata["verification"] = {
        "readme_non_empty": target.metadata.get("readme_non_empty", False),
        "has_architecture_doc": bool(arch_matches),
        "has_prompts_dir_or_system_prompt": bool(prompt_matches),
        "has_tools_or_skills": bool(tool_matches),
        "appears_abandoned": appears_abandoned(target),
        "restrictive_license": bool(license_warning),
    }
    target.metadata["warnings"] = target.warnings
    target.metadata["errors"] = target.errors
    (out / "METADATA.json").write_text(json.dumps(target.metadata, indent=2, sort_keys=True), encoding="utf-8")
    target.extracted_files.append(str((out / "METADATA.json").relative_to(ROOT)))


def unique_paths(paths: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    out: list[Path] = []
    for p in paths:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def copy_collection(repo: Path, out: Path, dirname: str, paths: list[Path], target: RepoTarget) -> None:
    dest_dir = out / dirname
    dest_dir.mkdir(parents=True, exist_ok=True)
    index: list[str] = [f"# {dirname}\n"]
    for src in paths:
        rel = src.relative_to(repo)
        dst = dest_dir / relative_safe_name(src, repo)
        if copy_file(src, dst, target):
            index.append(f"- `{rel.as_posix()}` -> `{dst.relative_to(out).as_posix()}`")
    (dest_dir / "INDEX.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    target.extracted_files.append(str((dest_dir / "INDEX.md").relative_to(ROOT)))


def write_combined_architecture(repo: Path, dst: Path, paths: list[Path], target: RepoTarget) -> None:
    parts = ["# Architecture\n"]
    for p in paths:
        rel = p.relative_to(repo).as_posix()
        parts.append(f"\n## {rel}\n")
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
            parts.append(text[:80_000])
            if len(text) > 80_000:
                parts.append("\n\n[Truncated at 80,000 characters in combined view; full copied file may be available in ARCHITECTURE_FILES.]\n")
        except Exception as e:
            parts.append(f"Could not read: {e}\n")
    dst.write_text("\n".join(parts), encoding="utf-8")
    target.extracted_files.append(str(dst.relative_to(ROOT)))


def identify_key_files(repo: Path, files: list[Path], dst: Path, target: RepoTarget) -> None:
    categories = {
        "Main agent loop / orchestrator": ["agent loop", "run loop", "orchestrator", "planner", "executor", "while", "tool call"],
        "Tool/skill registry": ["tool registry", "registertool", "register_tool", "tools:", "skill", "mcp"],
        "System prompt assembly": ["system prompt", "system_prompt", "system-prompt", "prompt builder", "instructions"],
        "Retry/recovery code": ["retry", "recovery", "backoff", "fallback", "repair", "parse error"],
        "Memory read/write": ["memory", "recall", "remember", "embedding", "vector", "episodic"],
        "WebSocket/streaming": ["websocket", "eventsource", "sse", "stream", "heartbeat"],
    }
    candidates = [p for p in files if p.suffix.lower() in {".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".md"} and is_text_candidate(p)]
    lines = ["# Key Files\n"]
    target.key_files = {}
    for title, words in categories.items():
        scored: list[tuple[int, Path, str]] = []
        for p in candidates:
            rel_low = p.relative_to(repo).as_posix().lower()
            score = sum(3 for w in words if w.replace(" ", "") in rel_low.replace("-", "").replace("_", ""))
            try:
                if p.stat().st_size <= 500_000:
                    text = p.read_text(encoding="utf-8", errors="replace").lower()[:500_000]
                    score += sum(text.count(w) for w in words[:4])
                    score += sum(1 for w in words[4:] if w in text)
            except Exception:
                pass
            if score > 0:
                purpose = purpose_from_path(p.relative_to(repo).as_posix(), title)
                scored.append((score, p, purpose))
        scored.sort(key=lambda x: x[0], reverse=True)
        lines.append(f"\n## {title}\n")
        selected = []
        for _, p, purpose in scored[:8]:
            rel = p.relative_to(repo).as_posix()
            lines.append(f"- `{rel}`: {purpose}")
            selected.append((rel, purpose))
        if not selected:
            lines.append("- No strong heuristic match found.")
        target.key_files[title] = selected
    dst.write_text("\n".join(lines) + "\n", encoding="utf-8")
    target.extracted_files.append(str(dst.relative_to(ROOT)))


def purpose_from_path(rel: str, title: str) -> str:
    low = rel.lower()
    if "test" in low or "spec" in low:
        return f"Tests or examples around {title.lower()} behavior."
    if "prompt" in low:
        return "Prompt construction, prompt templates, or model-facing instructions."
    if "tool" in low or "skill" in low or "mcp" in low:
        return "Tool definition, registration, execution, or MCP integration logic."
    if "agent" in low or "loop" in low or "orchestr" in low:
        return "Agent orchestration and task execution control flow."
    if "memory" in low or "embed" in low or "vector" in low:
        return "Memory storage, retrieval, embedding, or recall logic."
    if "stream" in low or "websocket" in low or "sse" in low:
        return "Streaming transport or long-running connection handling."
    return f"Heuristic match for {title.lower()}."


def appears_abandoned(target: RepoTarget) -> bool:
    pushed = parse_date(target.metadata.get("pushed_at"))
    if not pushed:
        return False
    return pushed < NOW - dt.timedelta(days=STALE_DAYS)


def read_readme_excerpt(target: RepoTarget, max_chars: int = 900) -> str:
    if not target.extracted_path:
        return ""
    readme = target.extracted_path / "README.md"
    if not readme.exists():
        return target.metadata.get("description", "")
    text = readme.read_text(encoding="utf-8", errors="replace")
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", text)
    text = re.sub(r"\[[^\]]+\]\([^)]+\)", lambda m: m.group(0).split("](")[0].strip("["), text)
    text = re.sub(r"^[#>\-\*\s]+", "", text, flags=re.M)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_chars]


def synthesize_purpose(target: RepoTarget) -> str:
    desc = (target.metadata.get("description") or "").strip()
    excerpt = read_readme_excerpt(target)
    base = desc or excerpt
    if not base:
        base = f"{target.metadata.get('name', 'This repository')} is included for research in {target.category}."
    words = base.split()
    return " ".join(words[:78]) + ("..." if len(words) > 78 else "")


def relevance_for(target: RepoTarget) -> list[tuple[str, str]]:
    name = (target.metadata.get("name") or "").lower()
    cat = target.category
    out: list[tuple[str, str]] = []
    if cat in {"coding-agents", "edit-format-implementations"} or any(x in name for x in ["aider", "codex", "cline", "continue", "roo", "kilocode", "opencode"]):
        out.append(("weak-area-1", "Patch/edit formats, retryable application strategies, and model-facing edit prompts can improve Gemma 4 patch_file reliability."))
        out.append(("weak-area-2", "Planner/executor boundaries and task-loop heuristics are useful references for reducing unnecessary decomposition."))
        out.append(("weak-area-3", "Tool call schemas and prompt assembly show ways to keep LLM call surfaces small and explicit."))
        out.append(("weak-area-7", "CLI/UI transcript and diff display ideas can improve human-readable transparency."))
    if cat == "memory-systems":
        out.append(("weak-area-2", "Memory prioritization and retrieval can reduce repeated decomposition and context churn."))
        out.append(("weak-area-3", "Memory APIs are useful references for narrower structured schemas at LLM call sites."))
    if cat == "browser-agents":
        out.append(("weak-area-6", "Browser control loops, Playwright abstractions, and visual page state handling map directly to Zaraban browser control."))
        out.append(("weak-area-4", "Internet and vision workflows provide examples for web/vision capability integration."))
    if cat == "mcp-servers":
        out.append(("weak-area-4", "MCP tools cover download, website reading, screenshots, and multimodal extraction."))
        out.append(("weak-area-3", "Server tool schemas are compact examples of external capability surfaces."))
    if cat == "sandbox-runtimes":
        out.append(("weak-area-5", "Long-running sandbox lifecycle APIs inform heartbeat, idle, and background process handling."))
        out.append(("weak-area-8", "Remote execution transports provide examples for stream and connection resilience."))
    if cat == "eval-harnesses":
        out.append(("weak-area-1", "Benchmarks and grading harnesses can validate patch reliability and terminal workflows."))
        out.append(("weak-area-8", "Long-running task execution traces can reveal stream timeout and reliability issues."))
    if cat == "system-prompt-leaks":
        out.append(("weak-area-3", "Prompt and tool contracts provide reference constraints for smaller schema surfaces."))
        out.append(("weak-area-7", "Transparency patterns can be inferred from how agents explain state, tools, and edits."))
    if "websocket" in json.dumps(target.key_files).lower() or "stream" in json.dumps(target.key_files).lower():
        out.append(("weak-area-8", "Contains stream/WebSocket/SSE handling worth inspecting for long-output robustness."))
    return out[:5]


def adoption_posture(target: RepoTarget) -> str:
    lic = (target.metadata.get("license") or "").upper()
    if "AGPL" in lic or "GPL" in lic:
        return "REFERENCE (restrictive license; manual review before code adoption)"
    if target.errors and not target.clone_path:
        return "SKIP (clone or metadata failure)"
    if target.category in {"system-prompt-leaks", "eval-harnesses"}:
        return "REFERENCE"
    if target.category in {"mcp-servers", "browser-agents", "sandbox-runtimes"}:
        return "CLONE_PATTERNS"
    if target.category == "coding-agents" and (target.metadata.get("name") or "").lower() in {"aider", "codex"}:
        return "VENDOR (port specific edit/prompt patterns only after license review)"
    return "CLONE_PATTERNS"


def repo_sort_score(target: RepoTarget) -> tuple[int, int]:
    rel = len(relevance_for(target))
    stars = int(target.metadata.get("stars") or 0)
    return (rel, stars)


def write_manifest(targets: list[RepoTarget], web_sources: list[dict[str, str]]) -> None:
    lines = ["# Zaraban Research Corpus Manifest\n", f"Generated: {NOW.isoformat()}\n"]
    lines.append("This is the master index for cloned repositories, extracted research files, web captures, and synthesis notes.\n")
    for category in CATEGORY_DIRS:
        entries = [t for t in targets if t.category == category]
        if not entries:
            continue
        entries.sort(key=repo_sort_score, reverse=True)
        lines.append(f"\n# {category}\n")
        for t in entries:
            name = t.metadata.get("manifest_name") or t.metadata.get("name") or safe_name_from_url(t.url)
            extracted_name = t.metadata.get("extracted_name") or t.metadata.get("name") or safe_name_from_url(t.url)
            meta = t.metadata
            lines.append(f"\n## {name}\n")
            lines.append(f"- URL: {meta.get('canonical_url') or t.url}")
            lines.append(f"- Category: {category}")
            lines.append(
                f"- Stars: {meta.get('stars', 'unknown')} | Last commit: {meta.get('pushed_at', 'unknown')} | "
                f"License: {meta.get('license', 'unknown')} | Lang: {meta.get('primary_language_by_bytes') or meta.get('language', 'unknown')}"
            )
            lines.append(f"- Purpose: {synthesize_purpose(t)}")
            extracted = sorted(set(t.extracted_files))
            if extracted:
                lines.append("- Files extracted:")
                for f in extracted[:40]:
                    lines.append(f"  - `{f}`")
                if len(extracted) > 40:
                    lines.append(f"  - ... {len(extracted) - 40} more, see `extracted/{extracted_name}/`")
            else:
                lines.append("- Files extracted: none")
            lines.append("- Likely Zaraban relevance:")
            rels = relevance_for(t)
            if rels:
                for weak, reason in rels:
                    lines.append(f"  * {weak}: {reason}")
            else:
                lines.append("  * weak-area-general: Background reference; lower direct relevance than the category leaders.")
            lines.append(f"- Adoption posture: {adoption_posture(t)}")
            if t.warnings:
                lines.append(f"- Warnings: {'; '.join(t.warnings[:3])}")
            if t.errors:
                lines.append(f"- Errors: {'; '.join(t.errors[:3])}")
    lines.append("\n# Web Research Index\n")
    for src in web_sources:
        lines.append(f"- `{src['path']}`: {src['url']} ({src.get('status', 'unknown')})")
    MANIFEST.write_text("\n".join(lines) + "\n", encoding="utf-8")


class HTMLTextExtractor(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = False
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self.skip = True
        if tag == "title":
            self._in_title = True
        if tag in {"p", "br", "div", "section", "article", "h1", "h2", "h3", "li"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self.skip = False
        if tag == "title":
            self._in_title = False
        if tag in {"p", "div", "section", "article", "h1", "h2", "h3", "li"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip:
            return
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self.title += text
        self.parts.append(text + " ")

    def text(self) -> str:
        raw = html.unescape("".join(self.parts))
        raw = re.sub(r"[ \t]+", " ", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def html_to_markdownish(data: bytes, url: str) -> tuple[str, str]:
    parser = HTMLTextExtractor()
    parser.feed(data.decode("utf-8", errors="replace"))
    title = parser.title.strip() or url
    text = parser.text()
    return title, text


def slugify(text: str) -> str:
    text = re.sub(r"https?://", "", text)
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:120] or "source"


def save_web_markdown(category: str, url: str, web_sources: list[dict[str, str]]) -> None:
    status, data, final_url, content_type = fetch_url(url)
    out_dir = WEB_ROOT / category
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = slugify(final_url)
    path = out_dir / f"{slug}.md"
    if status != 200:
        path.write_text(f"# Fetch failed\n\nURL: {url}\nFinal URL: {final_url}\nStatus: {status}\n\n```\n{data.decode('utf-8', errors='replace')[:2000]}\n```\n", encoding="utf-8")
        log(f"Fetch failed {url}: status={status}")
    elif "application/pdf" in content_type:
        pdf_path = out_dir / f"{slug}.pdf"
        pdf_path.write_bytes(data)
        path.write_text(f"# PDF Capture\n\nURL: {url}\nFinal URL: {final_url}\nSaved PDF: `{pdf_path.name}`\n", encoding="utf-8")
    else:
        title, text = html_to_markdownish(data, final_url)
        path.write_text(f"# {title}\n\nSource: {url}\nFinal URL: {final_url}\nFetched: {NOW.isoformat()}\nStatus: {status}\n\n{text}\n", encoding="utf-8")
    web_sources.append({"category": category, "url": url, "status": str(status), "path": str(path.relative_to(ROOT))})


def discover_links_from_page(url: str, base_category: str, include_patterns: list[str], limit: int) -> list[str]:
    status, data, final_url, _ = fetch_url(url)
    if status != 200:
        log(f"Link discovery failed {url}: status={status}")
        return []
    text = data.decode("utf-8", errors="replace")
    hrefs = re.findall(r'href=["\']([^"\']+)["\']', text)
    links: list[str] = []
    for href in hrefs:
        full = urllib.parse.urljoin(final_url, href).split("#")[0]
        if full in links:
            continue
        low = full.lower()
        if any(p in low for p in include_patterns):
            links.append(full)
        if len(links) >= limit:
            break
    log(f"Discovered {len(links)} links from {url} for {base_category}")
    return links


def fetch_hn_threads(web_sources: list[dict[str, str]]) -> None:
    queries = [
        ("claude-code-leak", "Claude Code leak source map"),
        ("codex-internals", "Codex CLI OpenAI"),
    ]
    for category, query in queries:
        tags = "story"
        url = "https://hn.algolia.com/api/v1/search_by_date?" + urllib.parse.urlencode({"query": query, "tags": tags, "hitsPerPage": "5"})
        status, data, final_url, _ = fetch_url(url)
        out = WEB_ROOT / category / f"hn-{slugify(query)}.md"
        if status != 200:
            out.write_text(f"# HN fetch failed\n\nURL: {url}\nStatus: {status}\n", encoding="utf-8")
            log(f"HN search failed {query}: status={status}")
            continue
        payload = json.loads(data.decode("utf-8", errors="replace"))
        lines = [f"# HN Threads: {query}\n", f"Source: {final_url}\n"]
        cutoff = int((NOW - dt.timedelta(days=90)).timestamp())
        if category == "claude-code-leak":
            cutoff = int((NOW - dt.timedelta(days=60)).timestamp())
        for hit in payload.get("hits", []):
            if hit.get("created_at_i", 0) < cutoff:
                continue
            object_id = hit.get("objectID")
            lines.append(f"\n## {hit.get('title')}\n")
            lines.append(f"- HN: https://news.ycombinator.com/item?id={object_id}")
            lines.append(f"- URL: {hit.get('url')}")
            item_status, item_data, _, _ = fetch_url(f"https://hn.algolia.com/api/v1/items/{object_id}")
            if item_status == 200:
                item = json.loads(item_data.decode("utf-8", errors="replace"))
                for child in (item.get("children") or [])[:25]:
                    txt = re.sub(r"<[^>]+>", " ", child.get("text") or "")
                    txt = html.unescape(re.sub(r"\s+", " ", txt)).strip()
                    if txt:
                        lines.append(f"\n- {child.get('author', 'unknown')}: {txt[:900]}")
            time.sleep(0.5)
        out.write_text("\n".join(lines) + "\n", encoding="utf-8")
        web_sources.append({"category": category, "url": url, "status": str(status), "path": str(out.relative_to(ROOT))})


def fetch_web_research(web_sources: list[dict[str, str]]) -> None:
    for category, urls in WEB_TARGETS.items():
        for url in urls:
            save_web_markdown(category, url, web_sources)
            time.sleep(0.5)
    for url in discover_links_from_page("https://aider.chat/blog/", "blog-posts", ["/blog/"], 60):
        save_web_markdown("blog-posts", url, web_sources)
        time.sleep(0.25)
    for url in discover_links_from_page("https://www.anthropic.com/engineering", "blog-posts", ["/engineering/"], 25):
        save_web_markdown("blog-posts", url, web_sources)
        time.sleep(0.25)
    fetch_hn_threads(web_sources)


def arxiv_query(query: str, max_results: int = 5) -> list[dict[str, str]]:
    base = "https://export.arxiv.org/api/query?"
    url = base + urllib.parse.urlencode({"search_query": query, "start": "0", "max_results": str(max_results), "sortBy": "submittedDate", "sortOrder": "descending"})
    status, data, final_url, _ = fetch_url(url)
    if status != 200:
        log(f"arXiv query failed {query}: status={status}")
        return []
    xml = data.decode("utf-8", errors="replace")
    entries = re.findall(r"<entry>(.*?)</entry>", xml, flags=re.S)
    out = []
    for entry in entries:
        title = re.sub(r"\s+", " ", get_xml(entry, "title")).strip()
        arxiv_id = get_xml(entry, "id").rstrip("/").split("/")[-1]
        summary = re.sub(r"\s+", " ", get_xml(entry, "summary")).strip()
        published = get_xml(entry, "published")
        out.append({"title": title, "id": arxiv_id, "summary": summary, "published": published, "query_url": final_url})
    return out


def get_xml(text: str, tag: str) -> str:
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", text, flags=re.S)
    return html.unescape(m.group(1)) if m else ""


def fetch_papers(web_sources: list[dict[str, str]]) -> None:
    papers_dir = WEB_ROOT / "papers"
    index_lines = ["# Papers\n"]
    seen_ids: set[str] = set()
    for label, query in PAPER_QUERIES:
        results = arxiv_query(query, max_results=20 if "2025-2026" in label else 5)
        if not results and re.match(r"\d{4}\.\d{4,5}", query):
            results = [{"title": label, "id": query, "summary": "", "published": "", "query_url": ""}]
        kept = 0
        for paper in results:
            arxiv_id = paper["id"]
            if arxiv_id in seen_ids:
                continue
            published = parse_date(paper.get("published"))
            if "2025-2026" in label and published and published.year not in {2025, 2026}:
                continue
            seen_ids.add(arxiv_id)
            pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
            status, data, final_url, ctype = fetch_url(pdf_url, timeout=120)
            md_path = papers_dir / f"{slugify(label)}-{slugify(arxiv_id)}.md"
            if status == 200 and (b"%PDF" in data[:20] or "pdf" in ctype.lower()):
                pdf_path = papers_dir / f"{slugify(label)}-{slugify(arxiv_id)}.pdf"
                pdf_path.write_bytes(data)
                md_path.write_text(
                    f"# {paper['title']}\n\n"
                    f"- arXiv ID: {arxiv_id}\n- PDF: `{pdf_path.name}`\n- URL: {pdf_url}\n- Published: {paper.get('published')}\n\n"
                    f"{paper.get('summary', '')}\n",
                    encoding="utf-8",
                )
                web_sources.append({"category": "papers", "url": pdf_url, "status": str(status), "path": str(md_path.relative_to(ROOT))})
                index_lines.append(f"- `{md_path.name}`: {paper['title']} ({arxiv_id})")
                kept += 1
            else:
                md_path.write_text(f"# Paper fetch failed\n\nLabel: {label}\nQuery: {query}\nID: {arxiv_id}\nStatus: {status}\nURL: {pdf_url}\nResponse: {data[:500].decode('utf-8', errors='replace')}\n", encoding="utf-8")
                web_sources.append({"category": "papers", "url": pdf_url, "status": str(status), "path": str(md_path.relative_to(ROOT))})
                log(f"Paper fetch failed {label} {arxiv_id}: status={status}")
            if "2025-2026" not in label or kept >= 7:
                break
            time.sleep(1)
        time.sleep(1)
    (papers_dir / "INDEX.md").write_text("\n".join(index_lines) + "\n", encoding="utf-8")


def copy_codex_docs_to_web(targets: list[RepoTarget], web_sources: list[dict[str, str]]) -> None:
    codex = next((t for t in targets if (t.metadata.get("full_name") or "").lower() == "openai/codex"), None)
    if not codex or not codex.clone_path:
        return
    out_dir = WEB_ROOT / "codex-internals" / "openai-codex-docs"
    out_dir.mkdir(parents=True, exist_ok=True)
    for src in [find_readme(codex.clone_path)] + list((codex.clone_path / "docs").rglob("*")) if (codex.clone_path / "docs").exists() else [find_readme(codex.clone_path)]:
        if not src or not src.is_file() or not is_text_candidate(src):
            continue
        dst = out_dir / relative_safe_name(src, codex.clone_path)
        shutil.copy2(src, dst)
        web_sources.append({"category": "codex-internals", "url": "local clone openai/codex", "status": "copied", "path": str(dst.relative_to(ROOT))})


def write_hot_and_reliable(targets: list[RepoTarget]) -> None:
    def score(t: RepoTarget) -> int:
        stars = int(t.metadata.get("stars") or 0)
        pushed = parse_date(t.metadata.get("pushed_at"))
        recent = 0
        if pushed:
            days = (NOW - pushed).days
            recent = max(0, 120 - days)
        prod = 30 if int(t.metadata.get("forks") or 0) > 1000 else 0
        return recent * 4 + min(stars // 100, 150) + prod + len(relevance_for(t)) * 40

    ranked = sorted(targets, key=score, reverse=True)[:20]
    lines = ["# Hot and Reliable\n", "Top repositories ranked by recent activity, adoption signal, and direct Zaraban relevance.\n"]
    for i, t in enumerate(ranked, 1):
        name = t.metadata.get("manifest_name") or t.metadata.get("name") or safe_name_from_url(t.url)
        lines.append(f"\n## {i}. {name}\n")
        lines.append(
            f"Stars: {t.metadata.get('stars', 'unknown')}; last commit/push: {t.metadata.get('pushed_at', 'unknown')}; "
            f"license: {t.metadata.get('license', 'unknown')}. {synthesize_purpose(t)} "
            f"Best use: {adoption_posture(t)}. Zaraban signal: {'; '.join(r for _, r in relevance_for(t)[:2])}"
        )
    (SUMMARY_ROOT / "hot-and-reliable.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_gap_mapping(targets: list[RepoTarget], web_sources: list[dict[str, str]]) -> None:
    lines = ["# Zaraban Gap Mapping\n"]
    for idx, area in enumerate(WEAK_AREAS, 1):
        lines.append(f"\n## {idx}. {area}\n")
        scored: list[tuple[int, RepoTarget, str]] = []
        for t in targets:
            rel = " ".join(reason for weak, reason in relevance_for(t) if weak == f"weak-area-{idx}")
            if rel:
                stars = int(t.metadata.get("stars") or 0)
                scored.append((len(rel) + min(stars // 100, 100), t, rel))
        scored.sort(key=lambda x: x[0], reverse=True)
        if not scored:
            lines.append("- No strong repo match found; inspect web sources and general coding-agent patterns.")
        for _, t, rel in scored[:10]:
            name = t.metadata.get("manifest_name") or t.metadata.get("name") or safe_name_from_url(t.url)
            copy_note = copy_note_for_gap(idx, t)
            lines.append(f"- `{name}`: {rel} What to copy: {copy_note}")
        related_web = [s for s in web_sources if web_source_matches_gap(idx, s)]
        if related_web:
            lines.append("\nRelated web sources:")
            for s in related_web[:8]:
                lines.append(f"- `{s['path']}`")
    (SUMMARY_ROOT / "gap-mapping.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def copy_note_for_gap(idx: int, target: RepoTarget) -> str:
    name = (target.metadata.get("name") or "").lower()
    if idx == 1:
        if "aider" in name:
            return "edit format prompts, diff parsing, and retry/repair heuristics."
        return "patch application tests, model-facing edit contract, and failure recovery."
    if idx == 2:
        return "planner limits, task-state transitions, and memory-informed continuation criteria."
    if idx == 3:
        return "small tool schema shapes and prompt assembly boundaries."
    if idx == 4:
        return "download/read/screenshot/multimodal MCP capability contracts."
    if idx == 5:
        return "background sandbox lifecycle, heartbeat, and idle process status patterns."
    if idx == 6:
        return "browser action API, page-state summaries, and Playwright control loop."
    if idx == 7:
        return "transcript, diff, and status display patterns."
    if idx == 8:
        return "stream resumption, heartbeat, SSE/WebSocket backpressure, and timeout handling."
    return "architecture pattern only."


def web_source_matches_gap(idx: int, src: dict[str, str]) -> bool:
    p = src["path"].lower()
    if idx == 1:
        return any(x in p for x in ["aider", "cursor", "file-edits", "codex"])
    if idx == 3:
        return any(x in p for x in ["claude-code", "codex", "anthropic"])
    if idx == 4:
        return any(x in p for x in ["mcp", "browser", "vision", "skills"])
    if idx == 6:
        return any(x in p for x in ["browser", "stagehand", "playwright"])
    if idx == 8:
        return any(x in p for x in ["terminal", "codex", "openhands"])
    return False


def write_root_readme() -> None:
    readme = ROOT / "README.md"
    readme.write_text(
        "# Zaraban Research Corpus\n\n"
        "- Start with `MANIFEST.md` for the master index.\n"
        "- Use `summary/hot-and-reliable.md` for the highest-signal repos.\n"
        "- Use `summary/gap-mapping.md` to map sources to Zaraban weak areas.\n"
        "- Full clones are under `repos/`; extracted docs and key files are under `extracted/`.\n",
        encoding="utf-8",
    )


def main() -> int:
    ensure_structure()
    log("Started Zaraban research corpus collection")
    existing_urls = {t.url.rstrip("/") for t in TIER1_TARGETS}
    targets = list(TIER1_TARGETS)

    for target in targets:
        resolve_repo_metadata(target)
    tier2 = discover_tier2(existing_urls)
    for target in tier2:
        resolve_repo_metadata(target)
    targets.extend(tier2)
    targets = dedupe_targets(targets)

    for target in targets:
        clone_repo(target)

    extras = include_existing_local_repos(targets)
    targets.extend(extras)
    assign_unique_output_names(targets)
    for target in targets:
        extract_repo(target)

    web_sources: list[dict[str, str]] = []
    copy_codex_docs_to_web(targets, web_sources)
    fetch_web_research(web_sources)
    fetch_papers(web_sources)

    write_manifest(targets, web_sources)
    write_hot_and_reliable(targets)
    write_gap_mapping(targets, web_sources)
    write_root_readme()

    cloned = sum(1 for t in targets if t.clone_path and (t.clone_path / ".git").exists())
    failed = sum(1 for t in targets if t.errors)
    log(f"Completed corpus: {cloned}/{len(targets)} repos present, {failed} repos with logged errors, {len(web_sources)} web/paper captures")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        log("Interrupted by user")
        raise
