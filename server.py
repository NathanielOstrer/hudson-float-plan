#!/usr/bin/env python3
"""Float plan service.

Serves the single-page app and proxies two public data sources:
  NOAA CO-OPS  tide predictions and tidal-current predictions
  NWS api.weather.gov  hourly wind, sky, thunder and visibility

Both are cached in memory, because a sail window is re-read many times while
someone edits the form. Standard library only, so the Render build installs
nothing.
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
NY = ZoneInfo("America/New_York")

CURRENT_STATION = "NYH1928"      # Hudson River at Pier 92, nearest to Pier 66
CURRENT_BIN = "12"               # 6 ft below the surface
TIDE_STATION = "8518750"         # The Battery
GRID = "OKX/33,44"               # NWS grid cell covering Pier 66
UA = "hudson-float-plan (nathanielostrer@gmail.com)"

WATER_TTL = 24 * 3600            # astronomical, so a day is generous
WIND_TTL = 15 * 60               # NWS reissues about hourly

_cache = {}
_lock = threading.Lock()


def cached(key, ttl, build):
    """Return a cached value, or build it. On a build failure, serve a stale
    value if one exists, because a stale forecast beats no page."""
    now = time.time()
    with _lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    try:
        val = build()
    except Exception:
        if hit:
            return hit[1]
        raise
    with _lock:
        _cache[key] = (now, val)
    return val


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)


# ---------------------------------------------------------------- water
def fetch_water(day):
    """Tide highs and lows, plus slack and maximum current, for one local date."""
    span = day.replace("-", "")
    cur_url = ("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
               f"?product=currents_predictions&application=floatplan&begin_date={span}"
               f"&end_date={span}&station={CURRENT_STATION}&time_zone=lst_ldt"
               f"&interval=MAX_SLACK&units=english&format=json&bin={CURRENT_BIN}")
    tide_url = ("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
                f"?product=predictions&application=floatplan&begin_date={span}"
                f"&end_date={span}&datum=MLLW&station={TIDE_STATION}&time_zone=lst_ldt"
                "&interval=hilo&units=english&format=json")
    cur, tide = get_json(cur_url), get_json(tide_url)

    events = []
    for e in cur.get("current_predictions", {}).get("cp", []):
        hh, mm = e["Time"].split(" ")[1].split(":")
        kind = {"slack": "s", "flood": "f", "ebb": "e"}[e["Type"]]
        v = 0.0 if kind == "s" else round(abs(float(e["Velocity_Major"])), 2)
        events.append({"m": int(hh) * 60 + int(mm), "type": kind, "v": v})
    events.sort(key=lambda x: x["m"])

    tides = []
    for e in tide.get("predictions", []):
        hh, mm = e["t"].split(" ")[1].split(":")
        tides.append({"m": int(hh) * 60 + int(mm), "type": e["type"], "ft": round(float(e["v"]), 1)})
    tides.sort(key=lambda x: x["m"])

    if not events:
        raise RuntimeError("no current predictions for " + day)
    return {"date": day, "current": events, "tide": tides,
            "meta": {"currentStation": CURRENT_STATION, "tideStation": TIDE_STATION,
                     "floodDir": 26, "ebbDir": 212}}


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


def fetch_wind(day):
    p = get_json(f"https://api.weather.gov/gridpoints/{GRID}")["properties"]
    direction = expand(p.get("windDirection", {}))
    speed = expand(p.get("windSpeed", {}), KMH_TO_KT)
    gust = expand(p.get("windGust", {}), KMH_TO_KT)
    sky = expand(p.get("skyCover", {}))
    thunder = expand(p.get("probabilityOfThunder", {}))
    vis = expand(p.get("visibility", {}))
    rain = expand(p.get("probabilityOfPrecipitation", {}))
    temp = expand(p.get("temperature", {}))

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
    return {"date": day, "hours": hours,
            "issued": p.get("updateTime"), "source": "NWS " + GRID}


# ---------------------------------------------------------------- http
VALID_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TYPES = {".html": "text/html; charset=utf-8", ".json": "application/json",
         ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "floatplan"

    def log_message(self, fmt, *args):
        if os.environ.get("LOG_REQUESTS"):
            super().log_message(fmt, *args)

    def send_json(self, obj, status=200, cache_seconds=0):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", f"public, max-age={cache_seconds}" if cache_seconds else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self.send_json({"error": "not found"}, 404)
            return
        ext = os.path.splitext(path)[1]
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache" if ext == ".html" else "public, max-age=3600")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = urlparse(self.path)
        path = route.path.rstrip("/") or "/"
        query = parse_qs(route.query)
        day = (query.get("date") or [""])[0]

        if path in ("/api/water", "/api/wind"):
            if not VALID_DAY.match(day):
                self.send_json({"error": "give date as YYYY-MM-DD"}, 400)
                return
            try:
                if path == "/api/water":
                    self.send_json(cached("water:" + day, WATER_TTL, lambda: fetch_water(day)), cache_seconds=3600)
                else:
                    self.send_json(cached("wind:" + day, WIND_TTL, lambda: fetch_wind(day)), cache_seconds=300)
            except urllib.error.HTTPError as e:
                self.send_json({"error": f"upstream returned {e.code}"}, 502)
            except Exception as e:
                self.send_json({"error": type(e).__name__}, 502)
            return

        if path == "/api/health":
            self.send_json({"ok": True, "today": date.today().isoformat()})
            return

        if path == "/":
            self.send_file(os.path.join(STATIC, "index.html"))
            return

        name = os.path.normpath(path.lstrip("/"))
        target = os.path.join(STATIC, name)
        if os.path.commonpath([os.path.realpath(target), STATIC]) == STATIC and os.path.isfile(target):
            self.send_file(target)
            return
        self.send_file(os.path.join(STATIC, "index.html"))


def main():
    port = int(os.environ.get("PORT", "8020"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"float plan listening on 0.0.0.0:{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
