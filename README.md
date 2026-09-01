# Hudson Float Plan

A pre-sail float plan for keelboats leaving Pier 66 in Chelsea, New York.

Give it a date and a sail window. It reads the tide and the tidal current from
NOAA, and the hourly wind from the National Weather Service, then works out
which way to sail, when to turn around, and what stops the sail.

It records conditions and navigation only. There are no fields for names,
telephone numbers or contacts.

**Live at [nathanielostrer.com/hudson-float-plan](https://nathanielostrer.com/hudson-float-plan/)**

The user site `NathanielOstrer.github.io` carries a `CNAME` for
`nathanielostrer.com`, so every project site on this account is published under
that domain. `nathanielostrer.github.io/hudson-float-plan/` redirects there.

## How it works

There is no server. A GitHub Action reads NOAA and the NWS every three hours,
writes `docs/data/conditions.json`, and commits it. GitHub Pages serves
`docs/`. The page fetches that one file and does the rest in the browser.

| What | Source | Range |
|---|---|---|
| Tidal current | NOAA harmonic station `NYH1928`, Hudson River at Pier 92, 6 ft bin. The nearest current station to Pier 66, about 1.3 nm up-river. Mean flood sets 026°, mean ebb 212°. | 45 days ahead |
| Tide | NOAA station `8518750`, The Battery | 45 days ahead |
| Wind, sky, thunder, visibility | NWS gridpoint `OKX/33,44`, which covers Pier 66 | about 8 days ahead |

Current speeds between a slack and a maximum are interpolated on a sine curve,
which is closer to the real cycle than a straight line. Sunrise and sunset come
from the NOAA solar equations, computed in the page.

The data file is about 40 KB. If a date has tide but no wind, it is past the
NWS horizon, and the page says so. If the workflow stops, the page says how old
its numbers are.

## Run it

    python3 generate.py                  # read NOAA and the NWS
    python3 build.py                     # assemble docs/index.html from src/
    python3 -m http.server 8020 -d docs

No dependencies. The standard library covers all of it.

Edit the files in `src/`, never `docs/index.html`. That file is built.

## Test it

    python3 -m unittest discover -s tests -t .   # the generator
    node --test tests/*.test.js                  # the client model

Both run offline against recorded fixtures in `tests/fixtures`. There is an
end-to-end pass too, which drives the built site in a real browser. It needs
`playwright-core`, which is not a dependency of this repo:

    mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
    cd -
    PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core/index.js node tests/e2e.mjs

## Licence

MIT. See [LICENSE](LICENSE).
