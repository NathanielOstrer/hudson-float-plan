# Hudson Float Plan

A pre-sail float plan for keelboats leaving Pier 66 in Chelsea, New York.

Give it a date and a sail window. It reads the tide and the tidal current from
NOAA, and the hourly wind from the National Weather Service, then works out
which way to sail, when to turn around, and what stops the sail.

It records conditions and navigation only. There are no fields for names,
telephone numbers or contacts.

## Data

| What | Source |
|---|---|
| Tidal current | NOAA harmonic station `NYH1928`, Hudson River at Pier 92, 6 ft bin. The nearest current station to Pier 66, about 1.3 nm up-river. Mean flood sets 026°, mean ebb 212°. |
| Tide | NOAA station `8518750`, The Battery |
| Wind, sky, thunder, visibility | NWS gridpoint `OKX/33,44`, which covers Pier 66 |

Current speeds between a slack and a maximum are interpolated on a sine curve,
which is closer to the real cycle than a straight line. Sunrise and sunset come
from the NOAA solar equations, computed in the page.

## Run it

    python3 server.py            # listens on 8020, or on $PORT

No dependencies. The standard library covers all of it.

## Endpoints

| Path | Returns |
|---|---|
| `/` | the app |
| `/api/water?date=YYYY-MM-DD` | tide highs and lows, plus slack and maximum current |
| `/api/wind?date=YYYY-MM-DD` | hourly wind, gusts, sky, thunder and visibility |
| `/api/health` | a liveness check for Render |

Both data routes are cached in memory. Water is astronomical, so it is held for
a day. Wind is held for 15 minutes, because the NWS reissues about hourly. If an
upstream call fails and a cached copy exists, the cached copy is served.
