// #153: run_python failures come back as the exception and the agent's own lines, with the code on each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainFailure, summarizeJob } from '../../packages/core/src/pythonTool.js';

const CODE = [
  'import oh',
  'rows = oh.read_df("prices_daily")',
  'def avg(df):',
  '    return df["clse"].mean()',
  'print(avg(rows))',
].join('\n');
const STDERR = `Traceback (most recent call last):
  File "/work/main.py", line 5, in <module>
    print(avg(rows))
  File "/work/main.py", line 4, in avg
    return df["clse"].mean()
  File "/usr/local/lib/python3.12/site-packages/pandas/core/frame.py", line 4102, in __getitem__
    indexer = self.columns.get_loc(key)
KeyError: 'clse'
`;

test('the exception and the agent frames with their code', () => {
  assert.deepEqual(explainFailure(STDERR, CODE), {
    type: 'KeyError',
    message: "'clse'",
    lines: [
      { line: 5, function: '<module>', code: 'print(avg(rows))' },
      { line: 4, function: 'avg', code: 'return df["clse"].mean()' },
    ],
  });
  assert.equal(explainFailure('just a warning\n', CODE), undefined);
});

test('summarizeJob adds the failure only when the job failed', () => {
  const base = { id: 'j', stdout: '', stderr: STDERR, exitCode: 1 };
  assert.equal((summarizeJob({ ...base, status: 'failed' } as any, CODE) as any).failure.type, 'KeyError');
  assert.equal((summarizeJob({ ...base, status: 'succeeded' } as any, CODE) as any).failure, undefined);
});
