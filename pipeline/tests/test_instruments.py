"""Instrument classifier (#393): the shared vectors also run in tests/unit/instruments.test.ts."""
import json
import unittest
from pathlib import Path

from pipeline.core.instruments import instrument_type, is_equity

CASES = json.loads((Path(__file__).resolve().parents[2] / "tests/fixtures/instrument-types.json").read_text())["cases"]


class InstrumentTypes(unittest.TestCase):
    def test_live_vectors(self):
        for symbol, name, flags, want in CASES:
            got = instrument_type(symbol, name, flags.get("isEtf", False), flags.get("isFund", False), flags.get("isAdr", False))
            self.assertEqual(got, want, symbol)

    def test_equity(self):
        self.assertTrue(is_equity("AAPL", "Apple Inc."))
        self.assertTrue(is_equity("TSM", "Taiwan Semiconductor", is_adr=True))
        self.assertFalse(is_equity("SOJC", "The Southern Company JR 2017B NT 77"))


if __name__ == "__main__":
    unittest.main()
