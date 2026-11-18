import { expect, open, test } from "nsh/test";

const launch = (scenario = "welcome", locale = "en-US") =>
  open("./Harness.tsx", { width: 1180, height: 780, platform: "macos", locale, storage: { "harness.scenario": scenario } });

for (const zh of [false, true]) {
  const locale = zh ? "zh-CN" : "en-US";
  const search = zh ? "label:模型" : "label:Models";
  const configure = zh ? "配置 Pi" : "Configure Pi";
  const connect = zh ? "连接服务商后即可在此查看其模型。" : "Connect a provider to see its models here.";

  test(`a model search with no matches names the query, not provider setup (${locale})`, async () => {
    const app = await launch("welcome", locale);
    await app.waitFor(zh ? "text:今天要构建什么？" : "text:What are we building?");
    await app.press("text:Claude Sonnet 4.5");
    await app.type(search, "nonexistent-model");
    await app.waitFor(zh ? "text:没有与“nonexistent-model”匹配的模型。" : "text:No models match “nonexistent-model”.");
    expect(app.texts()).not.toContain(connect);
    expect(app.texts()).not.toContain(configure);
    await app.clear(search);
    await app.waitFor("text:DeepSeek Chat");
    await app.type(search, "GPT");
    await app.waitFor("text:GPT-5.1");
    expect(app.texts()).not.toContain("DeepSeek Chat");
  });

  test(`an empty model list offers provider setup even with a query (${locale})`, async () => {
    const app = await launch("connect", locale);
    await app.waitFor(zh ? "text:连接模型以开始使用" : "text:Connect a model to begin");
    await app.press(zh ? "text:无模型" : "text:No model");
    await app.waitFor(`text:${connect}`);
    expect(app.texts()).toContain(configure);
    await app.type(search, "nonexistent-model");
    expect(app.texts()).toContain(connect);
    expect(app.texts()).toContain(configure);
    await app.press(`text:${configure} >> nth=1`);
    await app.waitFor("text:Anthropic");
  });
}
