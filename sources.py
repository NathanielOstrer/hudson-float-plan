#!/usr/bin/env python3
"""Readers for the two public feeds behind the float plan.

  NOAA CO-OPS       tide predictions and tidal-current predictions
  NWS api.weather.gov  hourly wind, sky, thunder, visibility and temperature

Both readers take a date range and return one entry per local date. NOAA serves
a whole range from a single request, so a refresh is three upstream calls in
total. Standard library only.
"""
import json
import re
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

CURRENT_STATION = "NYH1928"      # Hudson River at Pier 92, nearest to Pier 66
CURRENT_BIN = "12"               # 6 ft below the surface
TIDE_STATION = "8518750"         # The Battery
GRID = "OKX/33,44"               # NWS grid cell covering Pier 66
UA = "hudson-float-plan (https://github.com/NathanielOstrer/hudson-float-plan)"

META = {"currentStation": CURRENT_STATION, "tideStation": TIDE_STATION,
        "floodDir": 26, "ebbDir": 212, "windSource": "NWS " + GRID}


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def date_range(start, end):
    """Every ISO date from start to end, both ends included."""
    out, day = [], start
    while day <= end:
        out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def _minutes(stamp):
    """'2026-09-01 13:45' -> ('2026-09-01', 825). NOAA gives local wall clock."""
    day, clock = stamp.split(" ")
    hh, mm = clock.split(":")
    return day, int(hh) * 60 + int(mm)


# ---------------------------------------------------------------- water
def fetch_water_range(start, end):
    """Tide highs and lows, plus slack and maximum current, keyed by local date.

    One request each. NOAA honours begin_date and end_date on both products, so
    a 47-day window costs two calls rather than ninety-four.
    """
    span_a, span_b = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")
    cur_url = ("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
               f"?product=currents_predictions&application=floatplan&begin_date={span_a}"
               f"&end_date={span_b}&station={CURRENT_STATION}&time_zone=lst_ldt"
               f"&interval=MAX_SLACK&units=english&format=json&bin={CURRENT_BIN}")
    tide_url = ("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
                f"?product=predictions&application=floatplan&begin_date={span_a}"
                f"&end_date={span_b}&datum=MLLW&station={TIDE_STATION}&time_zone=lst_ldt"
                "&interval=hilo&units=english&format=json")
    cur, tide = get_json(cur_url), get_json(tide_url)

    days = {d: {"current": [], "tide": []} for d in date_range(start, end)}

    for e in cur.get("current_predictions", {}).get("cp", []):
        day, m = _minutes(e["Time"])
        if day not in days:
            continue
        kind = {"slack": "s", "flood": "f", "ebb": "e"}[e["Type"]]
        v = 0.0 if kind == "s" else round(abs(float(e["Velocity_Major"])), 2)
        days[day]["current"].append({"m": m, "type": kind, "v": v})

    for e in tide.get("predictions", []):
        day, m = _minutes(e["t"])
        if day not in days:
            continue
        days[day]["tide"].append({"m": m, "type": e["type"], "ft": round(float(e["v"]), 1)})

    for d in days.values():
        d["current"].sort(key=lambda x: x["m"])
        d["tide"].sort(key=lambda x: x["m"])

    if not any(d["current"] for d in days.values()):
        raise RuntimeError(f"no current predictions for {span_a}..{span_b}")
    return days


# ---------------------------------------------------------------- wind
DUR = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$")


def duration_hours(text):
    m = DUR.match(text)
    if not m:
        return 1
    days, hours, mins = (int(g) if g else 0 for g in m.groups())
    return max(1, days * 24 + hours + (1 if mins else 0))


def expand(series, scale=1.0):
    """NWS gives values over ISO intervals. Spread each one across its hours."""
    out = {}
    for item in series.get("values", []):
        start_text, dur = item["validTime"].split("/")
        start = datetime.fromisoformat(start_text).astimezone(timezone.utc)
        val = item["value"]
        if val is None:
            continue
        if isinstance(val, list):          # the weather series is a list of objects
            val = val[0] if val else None
            if val is None:
                continue
        else:
            val = val * scale
        for h in range(duration_hours(dur)):
            out[start + timedelta(hours=h)] = val
    return out


KMH_TO_KT = 0.539957


def fetch_wind():
    """Every local date the gridpoint covers, as 24 hourly rows each.

    The NWS reaches about eight days ahead. A date is included only when at
    least one hour of it carries a speed or a direction.
    """
    p = get_json(f"https://api.weather.gov/gridpoints/{GRID}")["properties"]
    direction = expand(p.get("windDirection", {}))
    speed = expand(p.get("windSpeed", {}), KMH_TO_KT)
    gust = expand(p.get("windGust", {}), KMH_TO_KT)
    sky = expand(p.get("skyCover", {}))
    thunder = expand(p.get("probabilityOfThunder", {}))
    vis = expand(p.get("visibility", {}))
    rain = expand(p.get("probabilityOfPrecipitation", {}))
    temp = expand(p.get("temperature", {}))

    covered = sorted(set(speed) | set(direction))
    if not covered:
        raise RuntimeError("gridpoint carried no wind")
    first = covered[0].astimezone(NY).date()
    last = covered[-1].astimezone(NY).date()

    issued = p.get("updateTime")
    out = {}
    for day in date_range(first, last):
        y, mo, d = (int(x) for x in day.split("-"))
        hours = []
        for hh in range(24):
            local = datetime(y, mo, d, hh, tzinfo=NY)
            key = local.astimezone(timezone.utc)
            if key not in speed and key not in direction:
                continue
            row = {"m": hh * 60}
            if key in direction:
                row["dir"] = round(direction[key])
            if key in speed:
                row["kt"] = round(speed[key], 1)
            if key in gust:
                row["gust"] = round(gust[key], 1)
            if key in sky:
                row["sky"] = round(sky[key])
            if key in thunder:
                row["thunder"] = round(thunder[key])
            if key in vis:
                row["visNm"] = round(vis[key] / 1852.0, 1)
            if key in rain:
                row["rain"] = round(rain[key])
            if key in temp:
                row["tempF"] = round(temp[key] * 9 / 5 + 32) if temp[key] < 60 else round(temp[key])
            hours.append(row)
        if hours:
            out[day] = {"hours": hours, "issued": issued, "source": "NWS " + GRID}
    return out, issued
