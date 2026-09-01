"""Integration tests for the generator.

These run generate.build and generate.main against stubbed feeds, into a
temporary directory, and check the shape of the file the site actually reads.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import generate  # noqa: E402
import sources  # noqa: E402
from tests.test_sources import fixture, stub_get_json  # noqa: E402

TODAY = date(2026, 9, 1)


def synthesizing_water(url):
    """A NOAA stub that answers for whatever begin_date and end_date it is given.
    Used where a recorded fixture would pin the test to one month."""
    import re
    if "gridpoints" in url:
        raise RuntimeError("wind not under test here")
    a = date(*map(int, re.search(r"begin_date=(\d{4})(\d{2})(\d{2})", url).groups()))
    b = date(*map(int, re.search(r"end_date=(\d{4})(\d{2})(\d{2})", url).groups()))
    days = sources.date_range(a, b)
    if "currents_predictions" in url:
        return {"current_predictions": {"cp": [
            {"Time": d + " 03:00", "Type": "slack", "Velocity_Major": -0} for d in days]}}
    return {"predictions": [{"t": d + " 05:00", "type": "L", "v": "0.4"} for d in days]}


class Stubbed(unittest.TestCase):
    """Serve the recorded fixtures, and let a test knock one source out."""

    water_fails = False
    wind_fails = False

    def setUp(self):
        self._real = sources.get_json
        cur = fixture("noaa_currents.json")
        tide = fixture("noaa_tides.json")
        grid = fixture("nws_gridpoint.json")

        def fake(url):
            if "gridpoints" in url:
                if self.wind_fails:
                    raise RuntimeError("NWS down")
                return grid
            if self.water_fails:
                raise RuntimeError("NOAA down")
            return cur if "currents_predictions" in url else tide

        sources.get_json = fake
        # generate.main logs what it wrote. Keep that out of the test output.
        self._quiet = contextlib.ExitStack()
        self._quiet.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self._quiet.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.addCleanup(self._quiet.close)
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "data", "conditions.json")

    def tearDown(self):
        sources.get_json = self._real
        self.tmp.cleanup()

    def read(self):
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)


# ---------------------------------------------------------------- the clock
class TodayIsNewYork(unittest.TestCase):
    def test_late_evening_in_new_york_is_still_today(self):
        """21:00 on 1 Sep in New York is 01:00 on 2 Sep in UTC. Taking the UTC
        date would build the window a day late, every single evening."""
        now = datetime(2026, 9, 2, 1, 0, tzinfo=timezone.utc)
        self.assertEqual(generate.today_ny(now), date(2026, 9, 1))

    def test_morning_agrees_with_utc(self):
        now = datetime(2026, 9, 1, 14, 0, tzinfo=timezone.utc)
        self.assertEqual(generate.today_ny(now), date(2026, 9, 1))

    def test_across_the_new_year(self):
        now = datetime(2027, 1, 1, 3, 0, tzinfo=timezone.utc)
        self.assertEqual(generate.today_ny(now), date(2026, 12, 31))


# ---------------------------------------------------------------- the window
class WaterWindow(Stubbed):
    def test_the_window_overhangs_by_one_day_at_each_end(self):
        """timeline() reads the day before and the day after the sail date, so
        the first and last usable dates need a neighbour on the outside."""
        bundle, failed = generate.build(TODAY, {})
        self.assertEqual(failed, [])
        self.assertEqual(bundle["waterDates"][0], "2026-08-31")
        self.assertEqual(bundle["waterDates"][-1], "2026-10-16")
        self.assertEqual(len(bundle["waterDates"]),
                         generate.WATER_BEHIND + generate.WATER_AHEAD + 1)

    def test_every_listed_date_has_a_water_block(self):
        bundle, _ = generate.build(TODAY, {})
        for d in bundle["waterDates"]:
            self.assertIn(d, bundle["water"])
            self.assertIn("current", bundle["water"][d])
            self.assertIn("tide", bundle["water"][d])

    def test_the_window_follows_the_date_it_is_given(self):
        """Synthesize rows for whatever range is asked for, so the window can be
        checked across a year boundary without a fixture for that year."""
        sources.get_json = synthesizing_water
        bundle, failed = generate.build(date(2026, 12, 31), {})
        self.assertNotIn("water", failed)
        self.assertEqual(bundle["waterDates"][0], "2026-12-30")
        self.assertEqual(bundle["waterDates"][-1], "2027-02-14")
        self.assertIn("2027-01-01", bundle["water"])


# ---------------------------------------------------------------- the shape
class BundleShape(Stubbed):
    def test_every_top_level_key_is_present(self):
        bundle, _ = generate.build(TODAY, {})
        self.assertEqual(sorted(bundle), ["generated", "meta", "water", "waterDates",
                                          "wind", "windIssued"])

    def test_generated_is_an_utc_instant_the_browser_can_parse(self):
        bundle, _ = generate.build(TODAY, {})
        stamp = bundle["generated"]
        self.assertTrue(stamp.endswith("Z"))
        parsed = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        self.assertLess(abs((datetime.now(timezone.utc) - parsed).total_seconds()), 120)

    def test_meta_carries_the_stations_and_the_set_directions(self):
        bundle, _ = generate.build(TODAY, {})
        self.assertEqual(bundle["meta"]["floodDir"], 26)
        self.assertEqual(bundle["meta"]["ebbDir"], 212)
        self.assertEqual(bundle["meta"]["currentStation"], "NYH1928")
        self.assertEqual(bundle["meta"]["tideStation"], "8518750")

    def test_wind_dates_are_a_subset_of_the_water_window(self):
        bundle, _ = generate.build(TODAY, {})
        self.assertTrue(set(bundle["wind"]) <= set(bundle["waterDates"]))

    def test_the_written_file_is_sorted_and_compact(self):
        self.assertEqual(generate.main(self.path, TODAY), 0)
        with open(self.path, encoding="utf-8") as f:
            raw = f.read()
        self.assertNotIn(", ", raw)                      # compact separators
        self.assertLess(raw.index('"generated"'), raw.index('"water"'))  # sorted keys
        self.assertTrue(raw.endswith("\n"))
        json.loads(raw)


# ---------------------------------------------------------------- failures
class SourceFailures(Stubbed):
    def test_a_wind_failure_carries_the_previous_wind_forward(self):
        """A stale forecast beats a blank page. The banner says how old it is."""
        good, _ = generate.build(TODAY, {})
        self.wind_fails = True
        bundle, failed = generate.build(TODAY, good)
        self.assertEqual(failed, ["wind"])
        self.assertEqual(bundle["wind"], good["wind"])
        self.assertEqual(bundle["windIssued"], good["windIssued"])
        self.assertTrue(bundle["water"])                 # water still refreshed

    def test_a_water_failure_carries_the_previous_water_forward(self):
        good, _ = generate.build(TODAY, {})
        self.water_fails = True
        bundle, failed = generate.build(TODAY, good)
        self.assertEqual(failed, ["water"])
        self.assertEqual(bundle["waterDates"], good["waterDates"])
        self.assertEqual(bundle["water"], good["water"])

    def test_both_failing_with_no_previous_file_exits_non_zero(self):
        self.water_fails = self.wind_fails = True
        self.assertEqual(generate.main(self.path, TODAY), 1)
        self.assertFalse(os.path.exists(self.path))

    def test_both_failing_with_a_previous_file_keeps_serving_it(self):
        self.assertEqual(generate.main(self.path, TODAY), 0)
        before = self.read()
        self.water_fails = self.wind_fails = True
        self.assertEqual(generate.main(self.path, TODAY), 0)
        after = self.read()
        self.assertEqual(after["water"], before["water"])
        self.assertEqual(after["wind"], before["wind"])

    def test_a_corrupt_previous_file_is_ignored_rather_than_fatal(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{ this is not json")
        self.assertEqual(generate.main(self.path, TODAY), 0)
        self.assertTrue(self.read()["water"])


# ---------------------------------------------------------------- writing
class Writing(Stubbed):
    def test_main_creates_the_data_directory(self):
        self.assertFalse(os.path.isdir(os.path.dirname(self.path)))
        self.assertEqual(generate.main(self.path, TODAY), 0)
        self.assertTrue(os.path.isfile(self.path))

    def test_two_runs_of_the_same_data_differ_only_in_the_timestamp(self):
        """Sorted keys keep the daily commit diff down to what actually moved."""
        generate.main(self.path, TODAY)
        first = self.read()
        generate.main(self.path, TODAY)
        second = self.read()
        first.pop("generated"), second.pop("generated")
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
