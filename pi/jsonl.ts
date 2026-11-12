/**
 * Strict JSONL framing (`docs/pi/rpc.md`): records end with LF and nothing
 * else. U+2028 and U+2029 are valid inside JSON strings, so the stream is
 * split here by hand rather than by a generic line reader.
 */
export function createLineSplitter(onLine: (line: string) => void) {
  let pending = "";
  return {
    /** Takes the next piece of the stream; calls `onLine` for each complete record in it. */
    push(chunk: string) {
      let start = 0;
      for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
        let line = pending + chunk.slice(start, end);
        pending = "";
        start = end + 1;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) onLine(line);
      }
      pending += chunk.slice(start);
    },
  };
}
