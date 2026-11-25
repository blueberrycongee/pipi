import { mount, signal, Text, View } from "nsh";
import { renderVeiledInlines } from "../views/Prose";
import { waveOf, type VeilChunk } from "../lib/veil";

const results = signal<Record<string, { width: number; attachments: number }>>({});

function report(key: string, lines: { text: string; bounds: { size: { width: number } } }[]) {
  const line = lines[0];
  if (!line) return;
  const attachments = [...line.text].filter((char) => char === "\uFFFC").length;
  results.update((all) => ({ ...all, [key]: { width: line.bounds.size.width, attachments } }));
}

const sample = "mianb  ivpn";
const inline = [{ type: "code", code: sample }] as const;
const active: VeilChunk[] = [
  {
    start: 0,
    end: sample.length,
    startedAt: Date.now(),
    durationMs: 60_000,
    wave: waveOf(sample),
  },
];

function Case(props: { id: string; chunks: VeilChunk[] }) {
  return (
    <Text style={{ width: 1000 }} onTextLayout={(e) => report(props.id, e.lines)}>
      {renderVeiledInlines(inline, props.chunks, "fg")}
    </Text>
  );
}

function App() {
  return (
    <View style={{ padding: 20, gap: 8, width: 1000 }}>
      <Case id="settled" chunks={[]} />
      <Case id="veiled" chunks={active} />
      <Text testID="results">{JSON.stringify(results())}</Text>
    </View>
  );
}

mount(App);
