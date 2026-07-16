"""Look up the current wind signal for a location (Python 3.9+, stdlib only).

    BAGYO_API_KEY=bgy_live_... python3 examples/lookup.py Bulacan
"""

import json
import os
import sys
import urllib.parse
import urllib.request

API = os.environ.get("BAGYO_API_URL", "http://localhost:3000")
KEY = os.environ.get("BAGYO_API_KEY", "bgy_live_demo0000000000000000000000000000")
query = sys.argv[1] if len(sys.argv) > 1 else "Batanes"

req = urllib.request.Request(
    f"{API}/v1/signals/lookup?q={urllib.parse.quote(query)}",
    headers={"Authorization": f"Bearer {KEY}"},
)
try:
    with urllib.request.urlopen(req) as res:
        body = json.load(res)
except urllib.error.HTTPError as e:
    err = json.load(e)["error"]
    sys.exit(f"{e.code} {err['code']}: {err['message']}")

data = body["data"]
if data["signal"]:
    s = data["signal"]
    where = data["query"]["matchedName"] or query
    partial = f" ({s['partialDescriptor']})" if s["partialDescriptor"] else ""
    cyclone = s["context"]["cyclone"]["pagasaName"]
    print(f"Signal No. {s['level']} over {where}{partial} — {cyclone} [{s['coverage']}]")
else:
    print(f"No wind signal currently in effect for {query}.")
print(f"\nSource: {body['source']}\n{body['disclaimer']}")
