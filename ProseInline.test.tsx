import { expect, open, test } from "nsh/test";

function measured(app: { texts(): string[] }): Record<string, { width: number; attachments: number }> | undefined {
  const encoded = app.texts().find((text) => text.startsWith("{\"") && text.includes("veiled"));
  if (!encoded) return undefined;
  try {
    return JSON.parse(encoded) as Record<string, { width: number; attachments: number }>;
  } catch {
    return undefined;
  }
}

test("an inline code span keeps one logical box while the veil cuts it for color", async () => {
  const app = await open("./dev/ProseInlineStage.tsx", { width: 500, height: 240 });
  await app.waitUntil(() => {
    const widths = measured(app);
    return widths?.settled !== undefined && widths.veiled !== undefined;
  });
  const widths = measured(app)!;
  expect(widths.veiled.attachments).toBe(widths.settled.attachments);
  expect(widths.veiled.attachments).toBe(2);
  expect(Math.abs(widths.veiled.width - widths.settled.width)).toBeLessThan(0.01);
});
