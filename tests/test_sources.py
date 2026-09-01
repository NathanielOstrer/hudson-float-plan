"""Unit tests for the two feed readers.

The upstream calls are stubbed with recorded responses in tests/fixtures, so the
suite runs offline and gives the same answer every time.
"""
import json
import os
import sys
import unittest
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sources  # noqa: E402

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fixture(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return json.load(f)


def stub_get_json(mapping, fail=()):
    """Route a URL to a fixture by a substring of the URL."""
    def inner(url):
        for needle, payload in mapping.items():
            if needle in url:
                if payload in fail:
                    raise RuntimeError("stubbed failure")
                return payload
        raise AssertionError("no fixture for " + url)
    return inner


NOAA_ROUTES = {
    "currents_predictions": None,
    "product=predictions": None,
    "gridpoints": None,
}


class StubbedSources(unittest.TestCase):
    def setUp(self):
        self.routes = {
            "currents_predictions": fixture("noaa_currents.json"),
            "product=predictions": fixture("noaa_tides.json"),
            "gridpoints": fixture("nws_gridpoint.json"),
        }
        self._real = sources.get_json
        sources.get_json = stub_get_json(self.routes)

    def tearDown(self):
        sources.get_json = self._real


# ---------------------------------------------------------------- durations
class DurationHours(unittest.TestCase):
    def test_hours(self):
        self.assertEqual(sources.duration_hours("PT1H"), 1)
        self.assertEqual(sources.duration_hours("PT6H"), 6)

    def test_days_and_mixed(self):
        self.assertEqual(sources.duration_hours("P1D"), 24)
        self.assertEqual(sources.duration_hours("P1DT3H"), 27)

    def test_minutes_round_up_to_an_hour(self):
        """A sub-hour interval still has to occupy its hour, or the hour is lost."""
        self.assertEqual(sources.duration_hours("PT30M"), 1)
        self.assertEqual(sources.duration_hours("PT2H30M"), 3)

    def test_malformed_falls_back_to_one(self):
        self.assertEqual(sources.duration_hours("nonsense"), 1)
        self.assertEqual(sources.duration_hours(""), 1)


# ---------------------------------------------------------------- expand
def series(*pairs):
    return {"values": [{"validTime": t, "value": v} for t, v in pairs]}


class Expand(unittest.TestCase):
    def test_interval_spreads_across_every_hour(self):
        out = sources.expand(series(("2026-09-01T03:00:00+00:00/PT6H", 10)))
        self.assertEqual(len(out), 6)
        keys = sorted(out)
        self.assertEqual(keys[0], datetime(2026, 9, 1, 3, tzinfo=timezone.utc))
        self.assertEqual(keys[-1], datetime(2026, 9, 1, 8, tzinfo=timezone.utc))
        self.assertTrue(all(v == 10 for v in out.values()))

    def test_null_value_is_skipped(self):
        out = sources.expand(series(("2026-09-01T03:00:00+00:00/PT1H", None)))
        self.assertEqual(out, {})

    def test_list_value_takes_the_first_element(self):
        out = sources.expand(series(("2026-09-01T03:00:00+00:00/PT1H", [{"weather": "rain"}])))
        self.assertEqual(list(out.values()), [{"weather": "rain"}])

    def test_empty_list_is_skipped(self):
        out = sources.expand(series(("2026-09-01T03:00:00+00:00/PT1H", [])))
        self.assertEqual(out, {})

    def test_scale_applies_to_numbers_only(self):
        speed = sources.expand(series(("2026-09-01T03:00:00+00:00/PT1H", 10)), sources.KMH_TO_KT)
        self.assertAlmostEqual(list(speed.values())[0], 5.39957, places=4)
        sky = sources.expand(series(("2026-09-01T03:00:00+00:00/PT1H", 10)))
        self.assertEqual(list(sky.values())[0], 10)

    def test_a_local_offset_is_normalised_to_utc(self):
        """NWS stamps are offset-aware. Two spellings of one instant must collide."""
        out = sources.expand(series(("2026-09-01T03:00:00+00:00/PT1H", 1),
                                    ("2026-08-31T23:00:00-04:00/PT1H", 2)))
        self.assertEqual(len(out), 1)
        self.assertEqual(list(out.values()), [2])


# ---------------------------------------------------------------- water
class FetchWaterRange(unittest.TestCase):
    def setUp(self):
        StubbedSources.setUp(self)

    def tearDown(self):
        StubbedSources.tearDown(self)

    def test_every_date_in_the_range_appears(self):
        out = sources.fetch_water_range(date(2026, 9, 1), date(2026, 9, 3))
        self.assertEqual(sorted(out), ["2026-09-01", "2026-09-02", "2026-09-03"])

    def test_rows_group_onto_their_own_date(self):
        out = sources.fetch_water_range(date(2026, 9, 1), date(2026, 9, 3))
        for day, block in out.items():
            self.assertTrue(block["current"], day)
            self.assertTrue(block["tide"], day)

    def test_a_date_outside_the_range_is_dropped(self):
        """The stub returns three days. Ask for one and keep one."""
        out = sources.fetch_water_range(date(2026, 9, 2), date(2026, 9, 2))
        self.assertEqual(list(out), ["2026-09-02"])

    def test_slack_is_zero_and_ebb_is_a_positive_magnitude(self):
        out = sources.fetch_water_range(date(2026, 9, 1), date(2026, 9, 3))
        events = [e for b in out.values() for e in b["current"]]
        self.assertTrue(any(e["type"] == "s" for e in events))
        self.assertTrue(any(e["type"] == "e" for e in events))
        for e in events:
            if e["type"] == "s":
                self.assertEqual(e["v"], 0.0)
            else:
                self.assertGreater(e["v"], 0.0)

    def test_events_are_sorted_by_minute(self):
        out = sources.fetch_water_range(date(2026, 9, 1), date(2026, 9, 3))
        for block in out.values():
            mins = [e["m"] for e in block["current"]]
            self.assertEqual(mins, sorted(mins))
            tmins = [e["m"] for e in block["tide"]]
            self.assertEqual(tmins, sorted(tmins))

    def test_minutes_are_wall_clock_past_local_midnight(self):
        out = sources.fetch_water_range(date(2026, 9, 1), date(2026, 9, 1))
        for e in out["2026-09-01"]["current"]:
            self.assertGreaterEqual(e["m"], 0)
            self.assertLess(e["m"], 1440)

    def test_an_empty_upstream_raises(self):
        sources.get_json = stub_get_json({
            "currents_predictions": {"current_predictions": {"cp": []}},
            "product=predictions": {"predictions": []},
        })
        with self.assertRaises(RuntimeError):
            sources.fetch_water_range(date(2026, 9, 1), date(2026, 9, 3))


# ---------------------------------------------------------------- wind
class FetchWind(unittest.TestCase):
    def setUp(self):
        StubbedSources.setUp(self)

    def tearDown(self):
        StubbedSources.tearDown(self)

    def test_returns_a_block_per_local_date(self):
        out, issued = sources.fetch_wind()
        self.assertEqual(issued, "2026-09-01T09:43:55+00:00")
        self.assertTrue(set(out) >= {"2026-09-01", "2026-09-02"})
        for day, block in out.items():
            self.assertTrue(block["hours"])
            self.assertEqual(block["issued"], issued)
            self.assertEqual(block["source"], "NWS OKX/33,44")

    def test_hours_are_minutes_past_local_midnight(self):
        out, _ = sources.fetch_wind()
        for block in out.values():
            for row in block["hours"]:
                self.assertEqual(row["m"] % 60, 0)
                self.assertLess(row["m"], 1440)

    def test_a_full_day_carries_twenty_four_hours(self):
        out, _ = sources.fetch_wind()
        self.assertEqual(len(out["2026-09-02"]["hours"]), 24)

    def test_visibility_converts_metres_to_nautical_miles(self):
        out, _ = sources.fetch_wind()
        row = next(r for r in out["2026-09-02"]["hours"] if "visNm" in r)
        self.assertGreater(row["visNm"], 0)
        self.assertLess(row["visNm"], 30)

    def test_celsius_below_sixty_converts_to_fahrenheit(self):
        """The reader treats a value under 60 as Celsius. 20 C is 68 F."""
        sources.get_json = stub_get_json({"gridpoints": {"properties": {
            "updateTime": "2026-09-01T09:00:00+00:00",
            "windSpeed": series(("2026-09-01T12:00:00+00:00/PT1H", 10)),
            "temperature": series(("2026-09-01T12:00:00+00:00/PT1H", 20)),
        }}})
        out, _ = sources.fetch_wind()
        self.assertEqual(out["2026-09-01"]["hours"][0]["tempF"], 68)

    def test_a_value_at_or_above_sixty_is_already_fahrenheit(self):
        sources.get_json = stub_get_json({"gridpoints": {"properties": {
            "updateTime": "2026-09-01T09:00:00+00:00",
            "windSpeed": series(("2026-09-01T12:00:00+00:00/PT1H", 10)),
            "temperature": series(("2026-09-01T12:00:00+00:00/PT1H", 72)),
        }}})
        out, _ = sources.fetch_wind()
        self.assertEqual(out["2026-09-01"]["hours"][0]["tempF"], 72)

    def test_dst_fall_back_keys_every_local_hour(self):
        """2026-11-01 has 25 hours in New York. The reader walks 24 local hours,
        so the repeated 01:00 must resolve, and no hour may be dropped."""
        vals = []
        # 04:00Z on 2026-11-01 is 00:00 EDT; the day ends at 05:00Z on 11-02 EST.
        start = datetime(2026, 11, 1, 4, tzinfo=timezone.utc)
        for h in range(30):
            t = start.replace(tzinfo=timezone.utc)
            t = t.fromtimestamp(start.timestamp() + h * 3600, timezone.utc)
            vals.append((t.strftime("%Y-%m-%dT%H:%M:%S+00:00") + "/PT1H", 10))
        sources.get_json = stub_get_json({"gridpoints": {"properties": {
            "updateTime": "2026-11-01T09:00:00+00:00",
            "windSpeed": series(*vals),
            "windDirection": series(*vals),
        }}})
        out, _ = sources.fetch_wind()
        self.assertIn("2026-11-01", out)
        hours = out["2026-11-01"]["hours"]
        self.assertEqual(len(hours), 24)
        self.assertEqual([r["m"] for r in hours], [h * 60 for h in range(24)])

    def test_no_wind_at_all_raises(self):
        sources.get_json = stub_get_json({"gridpoints": {"properties": {
            "updateTime": "2026-09-01T09:00:00+00:00"}}})
        with self.assertRaises(RuntimeError):
            sources.fetch_wind()


class DateRange(unittest.TestCase):
    def test_both_ends_are_included(self):
        out = sources.date_range(date(2026, 9, 1), date(2026, 9, 3))
        self.assertEqual(out, ["2026-09-01", "2026-09-02", "2026-09-03"])

    def test_a_single_day(self):
        self.assertEqual(sources.date_range(date(2026, 9, 1), date(2026, 9, 1)),
                         ["2026-09-01"])

    def test_crosses_a_month_and_a_year(self):
        self.assertEqual(sources.date_range(date(2026, 12, 31), date(2027, 1, 2)),
                         ["2026-12-31", "2027-01-01", "2027-01-02"])


if __name__ == "__main__":
    unittest.main()
