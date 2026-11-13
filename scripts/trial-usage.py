"""Messages you sent per day, from Hermes's own database. Read-only.

An upper bound, not the verdict: it cannot tell testing from real use (for Oct 14 to Nov 10 it marks
11 days, where reading the conversations found 5). The daily line in the vault trial note is the
measure; this checks that a day marked "not used" really had no messages.

Counts the messages you sent, by surface: Jarvis (desk), Discord (phone), the Hermes desktop app.
Left out: cron (the briefing), one-shot CLI calls, compacted or replayed rows, and the live probes
(their prompts are recognisable). Run:  python scripts/trial-usage.py [YYYY-MM-DD start] [days]
"""
import os, re, sqlite3, sys
from datetime import date, datetime, timedelta

start = date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else date(2026, 11, 13)
days = int(sys.argv[2]) if len(sys.argv) > 2 else 14
db = os.path.join(os.environ.get("LOCALAPPDATA", ""), "hermes", "state.db")
SURFACES = {"api_server": "jarvis", "discord": "discord", "desktop": "hermes-app"}
PROBE = re.compile(r"trust-probe|tamarind|pomegranate|Use the terminal tool to run exactly|Use web_search for \"capital of|"
                   r"jarvis-probe|Use the write_file tool|Use the read_file tool to read .*jarvis-probe", re.I)

c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = c.execute(
    """select s.source, m.timestamp, m.content from messages m join sessions s on s.id = m.session_id
       where m.role = 'user' and m.compacted = 0 and m.active = 1 and s.source in ('api_server','discord','desktop')
         and m.timestamp >= ? and m.timestamp < ?""",
    (datetime.combine(start, datetime.min.time()).timestamp(),
     datetime.combine(start + timedelta(days=days), datetime.min.time()).timestamp()),
).fetchall()

counts = {}
for source, ts, content in rows:
    if PROBE.search(str(content or "")):
        continue
    d = datetime.fromtimestamp(ts).date()
    counts.setdefault(d, {}).setdefault(SURFACES[source], set()).add((round(ts), str(content or "")[:200]))

used = 0
print(f"{'day':<12}{'jarvis':>8}{'discord':>9}{'hermes-app':>12}")
for i in range(days):
    d = start + timedelta(days=i)
    if d > date.today():
        break
    n = {k: len(v) for k, v in counts.get(d, {}).items()}
    real = n.get("jarvis", 0) + n.get("discord", 0)
    used += real > 0
    print(f"{d.isoformat():<12}{n.get('jarvis', 0):>8}{n.get('discord', 0):>9}{n.get('hermes-app', 0):>12}{'  used' if real else ''}")
print(f"\nDays with any messages from you (Jarvis or Discord): {used} of {min(days, (date.today() - start).days + 1)} so far. "
      f"Upper bound: testing counts too. Hermes-app turns are not counted.")
