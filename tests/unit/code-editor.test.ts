// #93 traceback markers for the code editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tracebackMarkers } from '../../apps/studio/src/editor/traceback.js';

test('the deepest main.py frame gets the exception message', () => {
  const stderr = `Traceback (most recent call last):
  File "/work/job-1/main.py", line 4, in <module>
    out = build(raw)
  File "/work/job-1/main.py", line 9, in build
    return raw["close"] / raw["prev"]
  File "/usr/lib/python3/site-packages/pandas/core/frame.py", line 4102, in __getitem__
    indexer = self.columns.get_loc(key)
KeyError: 'prev'
`;
  assert.deepEqual(tracebackMarkers(stderr), [{ line: 9, message: "KeyError: 'prev'", severity: 'error' }]);
});

test('syntax errors point at their line; unrelated stderr gives no markers', () => {
  const stderr = `  File "main.py", line 3
    if x
        ^
SyntaxError: expected ':'`;
  assert.deepEqual(tracebackMarkers(stderr), [
    { line: 3, message: "SyntaxError: expected ':'", severity: 'error' },
  ]);
  assert.deepEqual(tracebackMarkers('warning: something\n'), []);
  assert.deepEqual(tracebackMarkers(''), []);
});

test('oh.py frames are not mistaken for the user code', () => {
  const stderr = `Traceback (most recent call last):
  File "/work/j/main.py", line 2, in <module>
    oh.write("raw", [])
  File "/work/j/oh.py", line 88, in write
    raise PermissionError("undeclared output raw")
PermissionError: undeclared output raw`;
  assert.equal(tracebackMarkers(stderr)[0].line, 2);
});
