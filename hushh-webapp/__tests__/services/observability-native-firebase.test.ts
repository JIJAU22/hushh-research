import { beforeEach, describe, expect, it, vi } from "vitest";

const logEventMock = vi.fn();
let nativePlatform = "android";
vi.mock("@capacitor/app", () => ({ App: { getInfo: vi.fn().mockResolvedValue({version:"1.3.9",build:"10"}) } }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => nativePlatform,
  },
}));

vi.mock("@capacitor-firebase/analytics", () => ({
  FirebaseAnalytics: {
    logEvent: logEventMock,
  },
}));

import { App } from "@capacitor/app";
const adapter = async () => (await import("@/lib/observability/adapters/native-firebase")).nativeFirebaseAdapter;

describe("native Firebase analytics adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    logEventMock.mockReset();
    vi.mocked(App.getInfo).mockResolvedValue({version:"1.3.9",build:"10",id:"com.hussh.app",name:"One"});
    vi.doMock("@capacitor-firebase/analytics", () => ({FirebaseAnalytics:{logEvent:logEventMock}}));
    delete window.__HUSHH_NATIVE_TEST__;
  });

  it.each(["ios", "android"])("forwards %s events with native release metadata", async (platform) => {
    const nativeFirebaseAdapter = await adapter();
    nativePlatform = platform;
    await nativeFirebaseAdapter.track("growth_funnel_step_completed", {
      env: "uat",
      platform,
      event_category: "funnel",
      journey: "ria",
      step: "workspace_ready",
      app_version: "2.1.0",
      workspace_source: "ria_client_workspace",
      bool_flag: true,
      nullable_field: null,
    });

    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).toHaveBeenCalledWith({
      name: "growth_funnel_step_completed",
      params: {
        env: "uat",
        platform,
        event_category: "funnel",
        journey: "ria",
        step: "workspace_ready",
        app_version: "1.3.9",
        app_build: "10",
        workspace_source: "ria_client_workspace",
        bool_flag: "true",
      },
    });
  });
  it("blocks explicit reviewer automation before loading/sending analytics", async () => {
    const nativeFirebaseAdapter = await adapter();
    window.__HUSHH_NATIVE_TEST__ = {enabled:true,autoReviewerLogin:true};
    expect(nativeFirebaseAdapter.isAvailable()).toBe(false);
    await nativeFirebaseAdapter.track("page_view", {route_id:"one_dashboard",env:"production",platform:"android"});
    expect(logEventMock).not.toHaveBeenCalled();
    delete window.__HUSHH_NATIVE_TEST__;
  });

  it.each(["failure", "invalid build"])("omits caller build when native metadata has %s", async (mode) => {
    if(mode === "failure") vi.mocked(App.getInfo).mockRejectedValueOnce(new Error("unavailable"));
    else vi.mocked(App.getInfo).mockResolvedValueOnce({version:"1.3.9",build:"not a build",id:"com.hussh.app",name:"One"});
    const nativeFirebaseAdapter = await adapter();
    await nativeFirebaseAdapter.track("page_view", {app_version:"2.1.0",app_build:"private note",platform:"android"});
    expect(logEventMock.mock.calls[0][0].params.app_build).toBeUndefined();
    expect(logEventMock.mock.calls[0][0].params.app_version).toBe(mode === "failure" ? "unknown" : "1.3.9");
  });
  it("blocks reviewer admission while loading the native release", async () => {
    vi.mocked(App.getInfo).mockImplementationOnce(async () => {
      window.__HUSHH_NATIVE_TEST__ = {enabled:true,autoReviewerLogin:true};
      return {version:"1.3.9",build:"10",id:"com.hussh.app",name:"One"};
    });
    await (await adapter()).track("page_view", {platform:"android"});
    expect(logEventMock).not.toHaveBeenCalled();
  });
  it("blocks reviewer admission while loading Firebase", async () => {
    vi.doMock("@capacitor-firebase/analytics", async () => {
      await Promise.resolve();
      window.__HUSHH_NATIVE_TEST__ = {enabled:true,autoReviewerLogin:true};
      return {FirebaseAnalytics:{logEvent:logEventMock}};
    });
    await (await adapter()).track("page_view", {platform:"android"});
    expect(logEventMock).not.toHaveBeenCalled();
  });

});
