# Hudson Float Plan — working notes

A pre-sail float plan for keelboats out of Pier 66, Chelsea. Deployed on Render
as a free web service. It records conditions and navigation only; there are no
fields for names, telephone numbers or contacts, and that is deliberate.

## Layout

    server.py          stdlib HTTP server; proxies NOAA and the NWS, serves static/
    build.py           joins src/*.html + src/app.js into static/index.html
    src/head.html      all CSS, including both themes
    src/body.html      markup
    src/app.js         the whole client
    static/index.html  BUILT ARTEFACT — never edit it by hand
    render.yaml        Render blueprint

Edit files in `src/`, then run `python3 build.py`. Render runs `build.py` at
deploy time, so a commit that changes `src/` without rebuilding still deploys
correctly, but the committed `static/index.html` will look stale in diffs.

## Run and test

    python3 server.py               # 8020, or $PORT
    curl localhost:8020/api/health
    curl "localhost:8020/api/wind?date=$(date +%F)"

There is no test suite. Verification so far has been Playwright against a live
server, driving the form and reading the computed output. Chromium lives at
`~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-mac/headless_shell`,
and `playwright-core` is not installed at this path — install it in a scratch
directory and run the script from there.

## Things that matter

- **Times are New York wall-clock minutes past midnight,** end to end. NOAA is
  queried with `time_zone=lst_ldt`, and the client does arithmetic on plain
  integers. Do not introduce a `Date` object for a sail time, or a viewer in
  another timezone gets a wrong plan.
- **Flood sets 026° and runs up-river. Ebb sets 212° and runs down-river.** The
  ebb is stronger and longer than the flood, so a plan that beats the flood
  outbound can be impossible against the same day's ebb. `boatSpeed()` gates
  that, and produces the "stay near the dock" plan.
- **Current between a slack and a maximum is a sine curve,** not a straight
  line. See `currentAt()`.
- **NWS gridpoint series carry ISO intervals,** for example `PT2H`, and each
  value has to be spread across its hours. See `expand()` in `server.py`.
- **`updateTime` on a gridpoint lags by hours as a matter of course.** The
  "stale" warning fires only past 12 hours, or it cries wolf every morning.
- **All user-facing copy follows ASD-STE100.** One idea per sentence, active
  voice, no contractions, articles kept, one word per concept, and a warning
  gives the command before the reason. See the global CLAUDE.md.

## Next steps

- Verify the first Render deploy end-to-end from a phone. Free instances sleep
  after 15 minutes, so the first request takes about 50 seconds; decide whether
  that is acceptable or whether it wants a keep-warm ping.
- The wind comes from the NWS **land** gridpoint covering Pier 66. The marine
  zone forecast (`ANZ338`) describes the water better, and pier-head effects on
  the Hudson are real. Consider reading both and showing the marine one where
  they disagree.
- Water temperature is still typed by hand. NOAA station `8518750` publishes it
  as `water_temperature`; wire it into `/api/water`.
- `/api/water` fetches one date per call, so a sail window near midnight makes
  three round trips. Batch the three days into one upstream request.
- No tests. The current model (`currentAt`, `timeline`) and the forecast parser
  (`parseForecast`) are pure functions with clear inputs, and both carry real
  correctness risk. They deserve unit tests before anything else here changes.
- The published Artifact at claude.ai holds an older standalone build with the
  NOAA data embedded and no live wind. It is no longer the maintained copy. Fold
  it in or retire it.
