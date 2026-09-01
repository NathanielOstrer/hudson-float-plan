# Hudson Float Plan — working notes

A pre-sail float plan for keelboats out of Pier 66, Chelsea. A static site on
GitHub Pages, with no server and no runtime. It records conditions and
navigation only; there are no fields for names, telephone numbers or contacts,
and that is deliberate.

## Layout

    sources.py                 readers for NOAA and the NWS
    generate.py                writes docs/data/conditions.json
    build.py                   joins src/*.html + model.js + app.js into docs/index.html
    src/head.html              all CSS, including both themes
    src/body.html              markup
    src/model.js               the pure model: time, sun, current, wind, forecast reader
    src/app.js                 the page: state, form, analysis, rendering
    docs/index.html            BUILT ARTEFACT — never edit it by hand
    docs/data/conditions.json  BUILT ARTEFACT — written by generate.py
    .github/workflows/         refresh.yml every 3 hours, test.yml on push

Edit files in `src/`, then run `python3 build.py`. Both files under `docs/` are
generated and both are committed, because Pages serves the branch.

`src/model.js` holds no DOM, so Node can load it and test it. `build.py`
concatenates it ahead of `src/app.js`, so anything moved into it stays a plain
top-level `const` or `function` in the built page.

## Run and test

    python3 generate.py                          # read NOAA and the NWS
    python3 build.py                             # assemble docs/index.html
    python3 -m http.server 8020 -d docs

    python3 -m unittest discover -s tests -t .   # 46 generator tests
    node --test tests/*.test.js                  # 46 client model tests

Both suites run offline against recorded fixtures in `tests/fixtures`. Re-record
them by rerunning the calls in `sources.py` against the live APIs.

End to end, against the built site in a real browser:

    mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core && cd -
    PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core/index.js node tests/e2e.mjs

ESM ignores `NODE_PATH`, so the package location has to come from
`PLAYWRIGHT_CORE`, and it must point at `index.js`, not the directory. Chromium
lives at `~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-mac/headless_shell`.

## Things that matter

- **Times are New York wall-clock minutes past midnight,** end to end. NOAA is
  queried with `time_zone=lst_ldt`, and the client does arithmetic on plain
  integers. Do not introduce a `Date` object for a sail time, or a viewer in
  another timezone gets a wrong plan.
- **The generator's "today" comes from `America/New_York`.** The Action runs in
  UTC, so between 20:00 and midnight in New York the UTC date is already
  tomorrow. Use `generate.today_ny()`.
- **The water window overhangs by a day at each end.** `timeline()` reads the day
  before and the day after the sail date, so the first and last generated dates
  are never selectable. `clampDateInput()` enforces that on the picker.
- **Flood sets 026° and runs up-river. Ebb sets 212° and runs down-river.** The
  ebb is stronger and longer than the flood, so a plan that beats the flood
  outbound can be impossible against the same day's ebb. `boatSpeed()` gates
  that, and produces the "stay near the dock" plan.
- **Current between a slack and a maximum is a sine curve,** not a straight
  line. See `currentAt()` in `src/model.js`, and the test that pins the midpoint
  to `v * sin(pi/4)`.
- **NWS gridpoint series carry ISO intervals,** for example `PT2H`, and each
  value has to be spread across its hours. See `expand()` in `sources.py`.
- **`updateTime` on a gridpoint lags by hours as a matter of course.** The
  "stale" warning fires only past 12 hours, or it cries wolf every morning. The
  separate build-age banner fires past 6 hours, which is two missed refreshes.
- **A date with tide but no wind is past the NWS horizon, not a failed load.**
  The feed is one file, so there is no per-date failure. `autofillWind()` picks
  its message from whether `BUNDLE` loaded.
- **`refresh.yml` pushes with `secrets.REFRESH_TOKEN`, not `GITHUB_TOKEN`.**
  GitHub disables a scheduled workflow after 60 days with no repository
  activity, and a `GITHUB_TOKEN` commit does not reset that timer. Because a PAT
  push does trigger workflows, `test.yml` carries `paths-ignore: ['docs/**']`.
- **`REFRESH_TOKEN` is scoped to this repo, Contents read and write, and it does
  not expire.** A leak lets someone push to a repo that is public anyway, and
  nothing else. Secrets do not reach a workflow started by a fork's pull request,
  so an outside PR cannot read it. That protection breaks if a workflow ever uses
  `pull_request_target`, or if a PR that edits a workflow file gets merged. Do
  not add `pull_request_target`, and read workflow changes in every PR.
- **All user-facing copy follows ASD-STE100.** One idea per sentence, active
  voice, no contractions, articles kept, one word per concept, and a warning
  gives the command before the reason. See the global CLAUDE.md.

## Next steps

- Verify the first Pages deploy end-to-end from a phone, and confirm the page
  paints before the data file lands.
- The wind comes from the NWS **land** gridpoint covering Pier 66. The marine
  zone forecast (`ANZ338`) describes the water better, and pier-head effects on
  the Hudson are real. Consider reading both and showing the marine one where
  they disagree.
- Water temperature is still typed by hand. NOAA station `8518750` publishes it
  as `water_temperature`, but only as an observation, so a value baked in at
  build time is up to three hours stale. Decide whether a stamped observation
  beats an empty box before wiring it in.
- `analyze()`, `buildPlan()` and `boatSpeed()` in `src/app.js` are still
  untested, because they read the DOM. Moving `readInputs()` to hand a plain
  object to a pure `buildPlan()` would make the sail-plan logic testable, which
  is the last piece carrying real correctness risk.
- The published Artifact at claude.ai holds an older standalone build with the
  NOAA data embedded and no live wind. It is no longer the maintained copy. Fold
  it in or retire it.
