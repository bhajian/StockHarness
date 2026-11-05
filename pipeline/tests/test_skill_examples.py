"""#114: every complete plugin example in the seed skills (skills/*.md) is a valid plugin, and the ones that use
the synthetic market's collections pass test_strategy."""
import re
import unittest
from pathlib import Path

from pipeline.strategy import contract, job, synthetic

SKILLS = Path(__file__).resolve().parents[2] / "skills"


def examples():
    out = []
    for f in sorted(SKILLS.glob("*.md")):
        for block in re.findall(r"```python\n(.*?)```", f.read_text(), re.S):
            if "def signal(ctx)" in block and "META" in block and "..." not in block:
                out.append((f.name, block))
    return out


class SkillExamples(unittest.TestCase):
    def test_examples_are_valid_plugins(self):
        found = examples()
        self.assertGreaterEqual(len(found), 4)
        for name, code in found:
            with self.subTest(skill=name, code=code.splitlines()[0]):
                self.assertEqual(contract.validate(code), [])

    def test_examples_on_the_synthetic_market_pass_test_strategy(self):
        src, days = synthetic.market(n_sec=30, n_days=300, seed=8)
        ran = 0
        for name, code in examples():
            if not re.search(r'read_df\("(prices_daily|features_ranked)"', code) or "insider" in code or "fundamentals" in code:
                continue
            r = job.run({"action": "test", "code": code, "policies": synthetic.POLICIES, "readable_end": days[-1]}, src)
            self.assertTrue(r["ok"] and r["test"]["ok"], (name, r))
            ran += 1
        self.assertGreaterEqual(ran, 2)


if __name__ == "__main__":
    unittest.main()
