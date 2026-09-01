#!/usr/bin/env python3
"""Build docs/data/conditions.json, the whole data feed for the static site.

Runs from a scheduled GitHub Action every three hours. Reads NOAA and the NWS,
writes one file, and leaves the previous file's good sections in place when a
source fails. A stale forecast beats a blank page, but the page says how old it
is, so the reader can judge.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import sources
from sources import NY

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "docs", "data", "conditions.json")

WATER_BEHIND = 1     # timeline() reads the day before the sail date
WATER_AHEAD = 45     # NOAA is astronomical, so this is free


def today_ny(now=None):
    """The local sailing date, never the runner's UTC date. The Action runs in
    UTC, so between 20:00 and midnight in New York the UTC date is tomorrow."""
    return (now or datetime.now(timezone.utc)).astimezone(NY).date()


def load_previous(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def build(today, previous):
    """Return the bundle, plus a list of the sources that failed."""
    start = today - timedelta(days=WATER_BEHIND)
    end = today + timedelta(days=WATER_AHEAD)
    failed = []

    try:
        water = sources.fetch_water_range(start, end)
        water_dates = sources.date_range(start, end)
    except Exception as e:
        print(f"NOAA failed: {type(e).__name__}: {e}", file=sys.stderr)
        failed.append("water")
        water = previous.get("water", {})
        water_dates = previous.get("waterDates", sorted(water))

    try:
        wind, issued = sources.fetch_wind()
    except Exception as e:
        print(f"NWS failed: {type(e).__name__}: {e}", file=sys.stderr)
        failed.append("wind")
        wind = previous.get("wind", {})
        issued = previous.get("windIssued")

    bundle = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "windIssued": issued,
        "meta": sources.META,
        "waterDates": water_dates,
        "water": water,
        "wind": wind,
    }
    return bundle, failed


def write(bundle, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(bundle, f, separators=(",", ":"), sort_keys=True)
        f.write("\n")


def main(path=OUT, today=None):
    previous = load_previous(path)
    bundle, failed = build(today or today_ny(), previous)

    if not bundle["water"] and not bundle["wind"]:
        print("both sources failed and no previous file exists", file=sys.stderr)
        return 1

    write(bundle, path)
    size = os.path.getsize(path)
    print(f"wrote {path} ({size} bytes): "
          f"{len(bundle['water'])} water dates, {len(bundle['wind'])} wind dates"
          + (f", carried over {'+'.join(failed)}" if failed else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
