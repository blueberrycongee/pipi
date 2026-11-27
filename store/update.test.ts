import { expect, test } from "nsh/test";
import { fakeBackend } from "../dev/fake-pi";
import type { Backend } from "./backend";
import { useBackend } from "./backend";
import {
  _resetAppUpdateForTests,
  appUpdate,
  appUpdateVisible,
  beginAppUpdate,
  checkForAppUpdate,
  dismissAppUpdate,
} from "./update";

interface OfferedPackage {
  version: string;
  build: number;
}

function useUpdateBackend(offered: OfferedPackage) {
  const api = {
    offered,
    checks: 0,
    downloads: 0,
    downloaded: [] as string[],
    checkError: undefined as Error | undefined,
    failNextDownload: false,
  };
  const base = fakeBackend();
  const backend: Backend = {
    ...base,
    async checkAppPackage() {
      api.checks++;
      if (api.checkError) {
        const error = api.checkError;
        api.checkError = undefined;
        throw error;
      }
      return {
        version: api.offered.version,
        build: api.offered.build,
        notes: "Bug fixes",
        size: 1000,
      };
    },
    async checkAppUpdate() {
      return null;
    },
    async downloadAppPackage() {
      api.downloads++;
      api.downloaded.push(api.offered.version);
      if (api.failNextDownload) {
        api.failNextDownload = false;
        api.offered = { version: "0.2.37", build: 22 };
        throw new Error("HTTP 404");
      }
    },
  };
  _resetAppUpdateForTests();
  useBackend(backend);
  return api;
}

const version = () => {
  const s = appUpdate();
  return "update" in s ? s.update.version : undefined;
};

test("a background check refreshes an available update without undismissing the same one", async () => {
  const api = useUpdateBackend({ version: "0.2.34", build: 19 });

  await checkForAppUpdate();
  expect(version()).toBe("0.2.34");
  expect(api.checks).toBe(1);

  dismissAppUpdate();
  expect(appUpdateVisible()).toBe(false);

  await checkForAppUpdate();
  expect(api.checks).toBe(2);
  expect(version()).toBe("0.2.34");
  expect(appUpdateVisible()).toBe(false);

  api.offered = { version: "0.2.35", build: 20 };
  await checkForAppUpdate();
  expect(api.checks).toBe(3);
  expect(version()).toBe("0.2.35");
  expect(appUpdateVisible()).toBe(true);
});

test("starting a download revalidates the offer and downloads the newer one", async () => {
  const api = useUpdateBackend({ version: "0.2.34", build: 19 });
  await checkForAppUpdate();
  expect(version()).toBe("0.2.34");

  api.offered = { version: "0.2.36", build: 21 };
  await beginAppUpdate();

  expect(api.checks).toBe(2);
  expect(api.downloads).toBe(1);
  expect(api.downloaded).toEqual(["0.2.36"]);
  expect(appUpdate().phase).toBe("ready");
  expect(version()).toBe("0.2.36");
});

test("a failed download rechecks and replaces the offer that failed", async () => {
  const api = useUpdateBackend({ version: "0.2.34", build: 19 });
  await checkForAppUpdate();

  api.offered = { version: "0.2.36", build: 21 };
  api.failNextDownload = true;
  await beginAppUpdate();

  expect(api.downloads).toBe(1);
  expect(api.checks).toBe(3);
  expect(appUpdate().phase).toBe("available");
  expect(version()).toBe("0.2.37");
});

test("a failed preflight keeps the existing offer and does not download it", async () => {
  const api = useUpdateBackend({ version: "0.2.34", build: 19 });
  await checkForAppUpdate();

  api.checkError = new Error("offline");
  await beginAppUpdate();

  expect(api.checks).toBe(2);
  expect(api.downloads).toBe(0);
  expect(appUpdate().phase).toBe("available");
  expect(version()).toBe("0.2.34");
});
