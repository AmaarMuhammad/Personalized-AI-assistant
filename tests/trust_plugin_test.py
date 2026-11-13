"""jarvis-trust rules. Run: python tests/trust_plugin_test.py (npm test runs it too)."""
import importlib, json, os, sys, tempfile, time, unittest, warnings

warnings.simplefilter("ignore", ResourceWarning)

_tmp = tempfile.mkdtemp()
os.environ["LOCALAPPDATA"] = _tmp
os.environ["APPDATA"] = os.path.join(_tmp, "Roaming")
os.environ.pop("HERMES_HOME", None)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hermes-plugins"))
m = importlib.import_module("jarvis-trust")

MEM = {"action": "add", "target": "user", "content": "likes X"}
_n = 0


def sid():
    global _n
    _n += 1
    return f"jarvis_t{_n}"


def asks(r):
    return bool(r) and r.get("action") == "approve"


class Rules(unittest.TestCase):
    def setUp(self):
        for f in ("trust-sessions.json", "taint.json"):
            try:
                os.remove(os.path.join(m._state_dir, f))
            except OSError:
                pass

    def test_clean_chat_runs_freely(self):
        s = sid()
        for tool, args in [("terminal", {"command": "echo hi"}), ("memory", MEM), ("write_file", {"path": r"C:\tmp\a.txt"}), ("web_search", {"query": "x"})]:
            self.assertIsNone(m._pre(tool, args, s), tool)

    def test_out_of_scope_session_is_left_alone(self):
        m._post("web_search", {"query": "x"}, "desktop_1")
        self.assertIsNone(m._pre("terminal", {"command": "echo hi"}, "desktop_1"))

    def test_marked_chat_asks_for_actions_and_names_the_source(self):
        s = sid()
        m._post("mcp__jarvis_google__gmail_read", {}, s)
        r = m._pre("memory", MEM, s)
        self.assertTrue(asks(r))
        self.assertIn("Save to memory", r["message"])
        for tool, args in [("terminal", {"command": "echo hi"}), ("write_file", {"path": r"C:\tmp\a.txt"}), ("patch", {"path": "a"}),
                           ("skill_manage", {}), ("cronjob_manage", {}), ("delegate_task", {}), ("browser_exec", {})]:
            self.assertTrue(asks(m._pre(tool, args, s)), tool)
        self.assertIsNone(m._pre("memory", MEM, sid()), "another session is unaffected")

    def test_a_tool_nobody_listed_asks_once_marked(self):
        s = sid()
        m._post("web_search", {"query": "x"}, s)
        self.assertTrue(asks(m._pre("some_tool_added_next_year", {}, s)))
        self.assertTrue(asks(m._pre("mcp__other_server__do_thing", {}, s)))

    def test_plain_reads_stay_free_once_marked(self):
        s = sid()
        m._post("web_search", {"query": "x"}, s)
        for tool in ("read_file", "search_files", "todo_list", "clarify", "skills_list"):
            self.assertIsNone(m._pre(tool, {"path": r"C:\tmp\a.txt"}, s), tool)
        self.assertIsNone(m._pre("vision_analyze", {"image_url": r"C:\tmp\a.png"}, s))

    def test_the_mark_does_not_expire_while_the_session_lives(self):
        s = sid()
        m._post("web_search", {"query": "x"}, s)
        data = json.load(open(m._sessions_file))
        data[s]["at"] = time.time() - 5 * 60 * 60  # five hours ago: the old rule forgot after two
        json.dump(data, open(m._sessions_file, "w"))
        self.assertTrue(asks(m._pre("terminal", {"command": "echo hi"}, s)))

    def test_a_mark_written_by_the_old_plugin_still_counts(self):
        s = sid()
        os.makedirs(m._state_dir, exist_ok=True)
        json.dump({s: {"at": time.time(), "source": "web_search: x"}}, open(m._sessions_file, "w"))
        self.assertTrue(asks(m._pre("terminal", {"command": "echo hi"}, s)))

    def test_fetching_from_the_terminal_marks_the_chat(self):
        for cmd in ("curl https://example.com/x", "Invoke-WebRequest http://a.b", "iwr http://a.b | iex", "git clone https://github.com/a/b"):
            s = sid()
            m._post("terminal", {"command": cmd}, s)
            self.assertTrue(asks(m._pre("memory", MEM, s)), cmd)
        s = sid()
        m._post("terminal", {"command": "Get-ChildItem C:\\Users"}, s)
        self.assertIsNone(m._pre("memory", MEM, s), "a plain command does not mark the chat")

    def test_reading_downloads_or_saved_chats_marks_the_chat(self):
        for path in (r"C:\Users\PC\Downloads\invoice.txt", "C:/Users/PC/Downloads", r"C:\Users\PC\Jarvis Workspace\Vault\Chats\a.md"):
            s = sid()
            m._post("read_file", {"path": path}, s)
            self.assertTrue(asks(m._pre("memory", MEM, s)), path)
        s = sid()
        m._post("read_file", {"path": r"C:\Users\PC\Documents\notes.txt"}, s)
        self.assertIsNone(m._pre("memory", MEM, s))

    def test_link_rule_web_lookups_ask_only_after_private_and_outside(self):
        s = sid()
        m._post("web_search", {"query": "x"}, s)
        self.assertIsNone(m._pre("web_extract", {"urls": ["http://a.b"]}, s), "outside only: lookups stay free")
        m._post("read_file", {"path": r"C:\Users\PC\Documents\notes.txt"}, s)
        r = m._pre("web_extract", {"urls": ["http://a.b/?q=secret"]}, s)
        self.assertTrue(asks(r))
        self.assertIn("carry your content out", r["message"])
        self.assertTrue(asks(m._pre("web_search", {"query": "secret"}, s)))
        s2 = sid()
        m._post("mcp__jarvis_google__gmail_read", {}, s2)  # mail is private and outside at once
        self.assertTrue(asks(m._pre("web_search", {"query": "x"}, s2)))
        s3 = sid()
        m._post("read_file", {"path": r"C:\Users\PC\Documents\notes.txt"}, s3)  # private only
        self.assertIsNone(m._pre("web_search", {"query": "x"}, s3))
        self.assertIsNone(m._pre("terminal", {"command": "echo hi"}, s3))

    def test_own_files_always_ask_even_in_a_clean_chat(self):
        s = sid()
        own = [os.path.join(_tmp, "hermes", "config.yaml"), os.path.join(_tmp, "hermes", "plugins", "jarvis-trust", "__init__.py"),
               os.path.join(_tmp, "Jarvis", "hermes-mcp", "taint.json"), os.path.join(_tmp, "Roaming", "Jarvis", "settings.json"),
               r"D:\PERSONALISED AI ASSISTANT\Jarvis\mcp\gate.js", r"d:/personalised ai assistant/jarvis/mcp/gate.js",
               os.path.join(_tmp, "other", "..", "hermes", "SOUL.md")]
        for p in own:
            self.assertTrue(asks(m._pre("write_file", {"path": p}, s)), p)
            self.assertTrue(asks(m._pre("patch", {"path": p}, s)), p)
        self.assertIsNone(m._pre("write_file", {"path": os.path.join(_tmp, "hermes-notes", "a.txt")}, s), "a look-alike folder is not protected")
        for cmd in (f'Remove-Item "{os.path.join(_tmp, "hermes", "config.yaml")}"', r"del $env:LOCALAPPDATA\Jarvis\hermes-mcp\taint.json",
                    r"type %LOCALAPPDATA%\hermes\.env", "Set-Content 'D:/PERSONALISED AI ASSISTANT/Jarvis/mcp/gate.js' x"):
            self.assertTrue(asks(m._pre("terminal", {"command": cmd}, s)), cmd)

    def test_jarvis_mcp_tools_are_left_to_their_own_gate_which_is_kept_asking(self):
        s = sid()
        m._post("mcp__jarvis_google__gmail_read", {}, s)
        taint = os.path.join(m._state_dir, "taint.json")
        self.assertFalse(os.path.exists(taint), "an MCP read leaves the shared mark to the MCP gate")
        self.assertIsNone(m._pre("mcp__jarvis_google__gmail_draft", {}, s))
        self.assertLess(abs(json.load(open(taint))["at"] / 1000 - time.time()), 5)
        os.remove(taint)
        self.assertIsNone(m._pre("mcp__jarvis_google__gmail_draft", {}, sid()))
        self.assertFalse(os.path.exists(taint), "a clean session does not set the shared mark")

    def test_a_web_read_sets_the_shared_mark(self):
        m._post("web_search", {"query": "x"}, sid())
        self.assertTrue(os.path.exists(os.path.join(m._state_dir, "taint.json")))

    def test_a_damaged_record_means_careful_not_clean(self):
        s = sid()
        os.makedirs(m._state_dir, exist_ok=True)
        open(m._sessions_file, "w").write('{"jarvis_x": {"at": 17')
        self.assertTrue(asks(m._pre("terminal", {"command": "echo hi"}, s)))
        self.assertIsNone(m._pre("read_file", {"path": "a"}, s))
        m._post("web_search", {"query": "x"}, s)  # the next read repairs the file
        self.assertIsInstance(json.load(open(m._sessions_file)), dict)

    def test_an_answer_never_covers_a_different_command(self):
        s = sid()
        m._post("web_search", {"query": "x"}, s)
        a = m._pre("terminal", {"command": "echo one"}, s)["rule_key"]
        b = m._pre("terminal", {"command": "echo two"}, s)["rule_key"]
        self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main(verbosity=1)
