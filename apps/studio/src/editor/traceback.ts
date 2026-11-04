// #93 Python traceback → editor markers. The executor runs a transform as main.py, so the deepest main.py
// frame is the line that failed; the message is the final exception line (e.g. "KeyError: 'close'").
export type CodeMarker = { line: number; message: string; severity: 'error' | 'warning' };

export function tracebackMarkers(stderr: string, filename = 'main.py'): CodeMarker[] {
  if (!stderr) return [];
  const lines = stderr.replace(/\r/g, '').split('\n');
  const frame = new RegExp(`File "(?:[^"]*/)?${filename.replace(/\./g, '\\.')}", line (\\d+)`);
  let line = 0;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = frame.exec(lines[i]);
    if (m) {
      line = Number(m[1]);
      end = i;
    }
  }
  if (!line) return [];
  // The exception line: the first line after the frame that looks like "Name: message" or a bare "Name".
  const exception = lines
    .slice(end + 1)
    .find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Warning|Exit|Interrupt|Iteration)\b/.test(l.trim()));
  const message = (exception ?? lines.filter((l) => l.trim()).at(-1) ?? 'Error').trim();
  return [{ line, message, severity: 'error' }];
}
