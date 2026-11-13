"""jarvis-trust: the "untrusted chat" rule, applied to Hermes's own tools.

Why: Jarvis's MCP servers always ask before outward actions, but Hermes's built-in tools (terminal,
file writes, browser, skills, cron, sub-agents) don't know when a chat has read text someone else
wrote. A page or an email could say "run this" and the next call would only face Hermes's own check.

Rules (per Hermes session, so the desk, Discord and the briefing don't mark each other):
- Reading outside text marks the session: web and browser tools, mail, calendar, screen, clipboard,
  a terminal command that fetches from the network, and files under Downloads or Vault\\Chats.
- The mark lasts as long as the session does. The text stays in the chat, so the caution must too.
- In a marked session every tool asks, except the short SAFE list below. A tool this file has never
  heard of asks. (An allowlist: a new Hermes tool is covered the day it appears.)
- Link rule: once a marked session has also read private content (mail, files, command output),
  web lookups ask as well, because a URL or a search query can carry that content out.
- Jarvis's own MCP tools are left to their own gate (mcp/gate.js); this refreshes the shared mark so
  that gate keeps asking for as long as the session is marked.
- Self-protection: writing to Hermes's or Jarvis's own folders always asks, marked or not.
- No answer / no human = blocked. If the state file can't be read, every in-scope session is treated
  as marked.
- Scope: Jarvis desk (session ids "jarvis_...") and messaging platforms (Discord). The Hermes
  desktop chat, where the user watches each step, is not covered.
Never raises: a raising pre_tool_call blocks the tool.
"""
import hashlib, json, logging, os, re, threading, time

logger = logging.getLogger("jarvis-trust")
PRUNE = 30 * 24 * 60 * 60  # seconds; marks are dropped only when the session is this old

# Tools whose result is text someone else wrote.
OUTSIDE_READ = {
    "web_search", "web_extract", "x_search", "browser_exec", "browser_cdp", "video_analyze",
    "feishu_doc_read",
    # Jarvis MCP reads (their gate marks too; this marks the session)
    "mcp__jarvis_google__gmail_search", "mcp__jarvis_google__gmail_read",
    "mcp__jarvis_google__calendar_events",
    "mcp__jarvis_desktop__clipboard_read", "mcp__jarvis_desktop__screenshot",
}
# Tools whose result is the user's own private content.
PRIVATE_READ = {
    "read_file", "search_files", "terminal", "execute_code", "session_search", "read_terminal",
    "mcp__jarvis_google__gmail_search", "mcp__jarvis_google__gmail_read",
    "mcp__jarvis_google__calendar_events", "mcp__jarvis_google__calendar_free_time",
    "mcp__jarvis_desktop__clipboard_read", "mcp__jarvis_desktop__screenshot",
}
# In a marked session these still run without asking: they change nothing and send nothing out.
SAFE = {"read_file", "search_files", "session_search", "skill_view", "skills_list", "read_terminal",
        "todo_list", "clarify", "show_tip", "text_to_speech"}
# Lookups that send a query or URL out: safe in a marked session until it has read private content.
NET_READ = {"web_search", "web_extract", "x_search", "video_analyze", "vision_analyze"}
WRITES_FILES = {"write_file", "patch"}

NETWORK_CMD = re.compile(
    r"\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget|Start-BitsTransfer|DownloadString|"
    r"DownloadFile|Net\.WebClient|HttpClient|urllib|requests\.(get|post)|git\s+(clone|pull|fetch))\b",
    re.I)
OWN_DIRS_BY_VAR = re.compile(r"(localappdata|appdata)[%)}]?\\+(hermes|jarvis)\b|hermes_home", re.I)
OUTSIDE_PATH = re.compile(r"[\\/]downloads([\\/]|$)|[\\/]vault[\\/]+chats([\\/]|$)", re.I)

_local = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
_state_dir = os.path.join(_local, "Jarvis", "hermes-mcp")
_sessions_file = os.path.join(_state_dir, "trust-sessions.json")
_lock = threading.Lock()


def _norm(p: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.expandvars(os.path.expanduser(str(p or ""))))).rstrip("\\/")


def protected_roots() -> list:
    roots = [
        os.path.join(_local, "hermes"), os.path.join(_local, "Jarvis"),
        os.path.join(os.environ.get("APPDATA") or "", "Jarvis") if os.environ.get("APPDATA") else "",
        os.environ.get("HERMES_HOME") or "",
        os.environ.get("JARVIS_REPO_DIR") or r"D:\PERSONALISED AI ASSISTANT\Jarvis",
    ]
    return [_norm(r) for r in roots if r]


def is_protected_path(p: str) -> bool:
    if not p:
        return False
    try:
        full = _norm(os.path.realpath(os.path.abspath(os.path.expandvars(os.path.expanduser(str(p))))))
    except Exception:
        return True
    return any(full == r or full.startswith(r + os.sep) for r in protected_roots())


def _platform() -> str:
    try:
        from gateway.session_context import get_session_env
        return (os.getenv("HERMES_PLATFORM") or get_session_env("HERMES_SESSION_PLATFORM", "") or "").lower()
    except Exception:
        return (os.getenv("HERMES_PLATFORM") or "").lower()


def in_scope(session_id: str) -> bool:
    if str(session_id or "").startswith("jarvis_"):
        return True
    try:
        from gateway.session_context import session_is_messaging_surface
        return session_is_messaging_surface()  # Discord etc.
    except Exception:
        return False


def _load():
    """The marks, or None when the file exists but can't be read (callers treat that as marked)."""
    if not os.path.exists(_sessions_file):
        return {}
    try:
        with open(_sessions_file, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        now = time.time()
        return {k: v for k, v in data.items() if isinstance(v, dict) and now - v.get("at", 0) < PRUNE}
    except Exception:
        return None


def _write_json(path: str, data) -> None:
    os.makedirs(_state_dir, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _save(data: dict) -> None:
    _write_json(_sessions_file, data)


def _mark_shared(source: str) -> None:
    # Shared mark for Jarvis's MCP gates (mcp/gate.js reads { at: ms, source }).
    _write_json(os.path.join(_state_dir, "taint.json"), {"at": int(time.time() * 1000), "source": source})


def _source_of(tool_name: str, args: dict) -> str:
    a = args or {}
    for k in ("url", "urls", "query", "image_url", "video_url", "path", "command"):
        v = a.get(k)
        if v:
            v = v[0] if isinstance(v, list) and v else v
            return f"{tool_name}: {str(v)[:80]}"
    return tool_name


def is_outside_read(tool_name: str, args: dict) -> bool:
    a = args or {}
    if tool_name in OUTSIDE_READ:
        return True
    if tool_name == "vision_analyze":  # only when it fetched something from the web
        return str(a.get("image_url", "")).lower().startswith("http")
    if tool_name in ("terminal", "execute_code"):
        text = str(a.get("command") or a.get("code") or "")
        return bool(NETWORK_CMD.search(text) or OUTSIDE_PATH.search(text))
    if tool_name in ("read_file", "search_files"):
        return bool(OUTSIDE_PATH.search(str(a.get("path", "")) + os.sep))
    return False


def _post(tool_name: str = "", args=None, session_id: str = "", **_):
    try:
        if not in_scope(session_id):
            return
        outside = is_outside_read(tool_name, args or {})
        private = tool_name in PRIVATE_READ
        if not (outside or private):
            return
        with _lock:
            data = _load()
            if data is None:
                data = {}
            key = session_id or "_"
            cur = data.get(key) or {}
            entry = {
                "at": time.time(),
                "outside": bool(cur.get("outside", "source" in cur)) or outside,
                "private": bool(cur.get("private")) or private,
                "source": _source_of(tool_name, args or {}) if outside else cur.get("source", ""),
            }
            data[key] = entry
            _save(data)
        if outside:
            if not tool_name.startswith("mcp__jarvis_"):
                _mark_shared(entry["source"])
            logger.info("jarvis-trust: session %s marked untrusted (%s)", session_id, entry["source"])
    except Exception:
        logger.exception("jarvis-trust post_tool_call failed")


def describe(tool_name: str, args: dict) -> str:
    a = args or {}
    what = {
        "terminal": lambda: f"Run this command: {a.get('command', '')}",
        "execute_code": lambda: "Run a Python script",
        "write_file": lambda: f"Write the file {a.get('path', '')}",
        "patch": lambda: f"Edit the file {a.get('path', '')}",
        "skill_manage": lambda: "Change a Hermes skill",
        "cronjob_manage": lambda: f"Change scheduled jobs ({a.get('action', '')})",
        "delegate_task": lambda: "Hand work to a sub-agent",
        "memory": lambda: f"Save to memory ({a.get('action', '')}): {str(a.get('content') or a.get('old_text') or a.get('operations') or '')[:160]}",
        "web_search": lambda: f"Search the web for: {a.get('query', '')}",
        "web_extract": lambda: f"Open this address: {a.get('urls') or a.get('url') or ''}",
        "browser_exec": lambda: "Act in the browser",
    }.get(tool_name, lambda: f"Use {tool_name}")()
    return " ".join(str(what).split())[:300]


def _ask(tool_name: str, args: dict, why: str) -> dict:
    digest = hashlib.sha256(json.dumps(args or {}, sort_keys=True, default=str).encode()).hexdigest()[:12]
    return {"action": "approve", "message": f"{describe(tool_name, args)}? {why}",
            "rule_key": f"jarvis-trust:{tool_name}:{digest}"}


def _pre(tool_name: str = "", args=None, session_id: str = "", **_):
    try:
        if not in_scope(session_id):
            return None
        a = args or {}
        # Self-protection, marked or not.
        if tool_name in WRITES_FILES and is_protected_path(a.get("path", "")):
            return _ask(tool_name, a, "That is one of Jarvis's or Hermes's own files (settings, safety rules or code).")
        if tool_name in ("terminal", "execute_code"):
            text = os.path.normcase(str(a.get("command") or a.get("code") or "")).replace("/", "\\")
            if any(r in text for r in protected_roots()) or OWN_DIRS_BY_VAR.search(text):
                return _ask(tool_name, a, "It touches Jarvis's or Hermes's own files (settings, safety rules or code).")
        with _lock:
            data = _load()
        if data is None:
            mark = {"outside": True, "private": True, "source": "the safety record could not be read"}
        else:
            mark = data.get(session_id or "_")
        if not mark or not mark.get("outside", "source" in mark):
            return None
        if tool_name.startswith("mcp__jarvis_"):
            _mark_shared(mark.get("source") or "outside content")  # their own gate asks; keep it asking
            return None
        if tool_name in SAFE:
            return None
        if tool_name == "vision_analyze" and not str(a.get("image_url", "")).lower().startswith("http"):
            return None
        source = mark.get("source") or "outside content"
        if tool_name in NET_READ:
            if not mark.get("private"):
                return None
            return _ask(tool_name, a, f"This chat has read your private content and text someone else wrote ({source}), "
                                      "so a web address or search could carry your content out.")
        return _ask(tool_name, a, f"This chat has read text someone else wrote ({source}), so the idea may not be yours.")
    except Exception:
        logger.exception("jarvis-trust pre_tool_call failed; asking to be safe")
        return {"action": "approve", "message": f"Use {tool_name}? (safety check failed, so asking)",
                "rule_key": f"jarvis-trust:{tool_name}:error"}


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _pre)
    ctx.register_hook("post_tool_call", _post)
