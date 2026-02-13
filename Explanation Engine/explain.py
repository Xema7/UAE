import json
import argparse
from datetime import datetime, timedelta

# ---------- Arguments ----------
parser = argparse.ArgumentParser()
parser.add_argument("--log", default="user_logs.json")
parser.add_argument("--event_id", required=True)
args = parser.parse_args()

# ---------- Load Logs ----------
events = []
with open(args.log, "r", encoding="utf-8") as f:
    for line in f:
        events.append(json.loads(line))

# ---------- Find Decision ----------
decision = next(e for e in events if e["event_id"] == args.event_id)

decision_time = datetime.fromisoformat(
    decision["timestamp_utc"].replace("Z", "")
)
session_id = decision["session_id"]

window_start = decision_time - timedelta(minutes=30)

primary = []
supporting = []

# ---------- Causal Analysis ----------
for e in events:
    if e["session_id"] != session_id:
        continue

    t = datetime.fromisoformat(e["timestamp_utc"].replace("Z", ""))
    if not (window_start <= t < decision_time):
        continue

    if e["event_type"] == "search":
        primary.append({
            "event_id": e["event_id"],
            "event_type": "search",
            "timestamp": e["timestamp_utc"],
            "reason": "Search occurred shortly before the decision"
        })

    elif e.get("dwell_time_sec", 0) and e["dwell_time_sec"] >= 30:
        supporting.append({
            "event_id": e["event_id"],
            "event_type": e["event_type"],
            "timestamp": e["timestamp_utc"],
            "reason": "High engagement prior to decision"
        })

# ---------- Confidence ----------
if len(primary) >= 2:
    confidence = "high"
elif len(primary) == 1:
    confidence = "medium"
else:
    confidence = "low"

# ---------- Explanation Object ----------
explanation = {
    "decision": {
        "event_id": decision["event_id"],
        "event_type": decision["event_type"],
        "timestamp": decision["timestamp_utc"],
        "domain": decision["domain"],
        "session_id": decision["session_id"]
    },
    "context_window": {
        "start": window_start.isoformat() + "Z",
        "end": decision["timestamp_utc"]
    },
    "primary_causes": primary[:2],
    "supporting_events": supporting,
    "explanation_confidence": confidence
}

# ---------- Write JSON ----------
with open("explanation.json", "w", encoding="utf-8") as f:
    json.dump(explanation, f, indent=2)

# ---------- Write Human Explanation ----------
with open("explanation.txt", "w", encoding="utf-8") as f:
    f.write("Decision Explanation\n")
    f.write("====================\n\n")
    f.write(f"Decision: {decision['event_type']}\n")
    f.write(f"Time: {decision['timestamp_utc']}\n")
    f.write(f"Domain: {decision['domain']}\n\n")

    if primary:
        f.write("Primary reasons:\n")
        for p in primary:
            f.write(f"- {p['reason']} ({p['event_type']})\n")
    else:
        f.write("No strong primary causes detected.\n")

    if supporting:
        f.write("\nSupporting context:\n")
        for s in supporting:
            f.write(f"- {s['reason']} ({s['event_type']})\n")

    f.write(f"\nConfidence: {confidence}\n")

print("✔ Explanation generated: explanation.json, explanation.txt")
