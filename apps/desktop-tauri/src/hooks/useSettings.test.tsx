import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => {
  const listeners: Record<string, () => void> = {};
  return {
    listeners,
    listen: vi.fn((name: string, cb: () => void) => {
      listeners[name] = cb;
      return Promise.resolve(() => {
        delete listeners[name];
      });
    }),
  };
});

const tauriMocks = vi.hoisted(() => ({
  getSettingsSnapshot: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => eventMocks);
vi.mock("../lib/tauri", () => tauriMocks);

import { useSettings } from "./useSettings";
import type { SettingsSnapshot } from "../types/bridge";

const snapshot = (windowScalePercent: number) =>
  ({ windowScalePercent }) as unknown as SettingsSnapshot;

describe("useSettings live sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-fetches the snapshot when settings-changed fires from another window", async () => {
    tauriMocks.getSettingsSnapshot.mockResolvedValue(snapshot(100));
    // Stable identity: the hook's bootstrap effect keys on `initial`, so a new
    // object each render would loop forever.
    const initial = snapshot(100);
    const { result } = renderHook(() => useSettings(initial));

    // The hook registers a "settings-changed" listener.
    await waitFor(() =>
      expect(eventMocks.listeners["settings-changed"]).toBeTypeOf("function"),
    );

    // A change persisted by the detached Settings window bumps the scale.
    tauriMocks.getSettingsSnapshot.mockResolvedValue(snapshot(175));
    await act(async () => {
      eventMocks.listeners["settings-changed"]();
    });

    await waitFor(() =>
      expect(result.current.settings.windowScalePercent).toBe(175),
    );
  });

  it("unsubscribes the listener on unmount", async () => {
    const unlisten = vi.fn();
    eventMocks.listen.mockResolvedValueOnce(unlisten);
    tauriMocks.getSettingsSnapshot.mockResolvedValue(snapshot(100));

    const initial = snapshot(100);
    const { unmount } = renderHook(() => useSettings(initial));
    await waitFor(() => expect(eventMocks.listen).toHaveBeenCalled());

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});

describe("useSettings update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.getSettingsSnapshot.mockResolvedValue(snapshot(100));
  });

  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("applies the patch before the shell answers and keeps saving off for a fast save", async () => {
    const pending = deferred<SettingsSnapshot>();
    tauriMocks.updateSettings.mockReturnValueOnce(pending.promise);
    const initial = snapshot(100);
    const { result } = renderHook(() => useSettings(initial));
    // Let the bootstrap snapshot fetch settle so it cannot overwrite the update.
    await act(async () => {});

    let done!: Promise<void>;
    act(() => {
      done = result.current.update({ windowScalePercent: 150 });
    });

    expect(result.current.settings.windowScalePercent).toBe(150);
    expect(result.current.saving).toBe(false);

    await act(async () => {
      pending.resolve(snapshot(150));
      await done;
    });
    expect(result.current.settings.windowScalePercent).toBe(150);
    expect(result.current.saving).toBe(false);
  });

  it("reports saving only once a save is slow", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<SettingsSnapshot>();
      tauriMocks.updateSettings.mockReturnValueOnce(pending.promise);
      const initial = snapshot(100);
      const { result } = renderHook(() => useSettings(initial));

      let done!: Promise<void>;
      act(() => {
        done = result.current.update({ windowScalePercent: 150 });
      });
      expect(result.current.saving).toBe(false);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current.saving).toBe(true);

      await act(async () => {
        pending.resolve(snapshot(150));
        await done;
      });
      expect(result.current.saving).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges a per-provider accent color patch instead of replacing the map", async () => {
    tauriMocks.updateSettings.mockReturnValueOnce(new Promise(() => {}));
    const initial = {
      providerAccentColors: { claude: "#111111", codex: "#222222" },
    } as unknown as SettingsSnapshot;
    tauriMocks.getSettingsSnapshot.mockResolvedValue(initial);
    const { result } = renderHook(() => useSettings(initial));
    await act(async () => {});

    act(() => {
      void result.current.update({ providerAccentColors: { claude: null, grok: "#333333" } });
    });

    expect(result.current.settings.providerAccentColors).toEqual({
      codex: "#222222",
      grok: "#333333",
    });
  });

  it("ignores a stale response that arrives after a newer save", async () => {
    const first = deferred<SettingsSnapshot>();
    const second = deferred<SettingsSnapshot>();
    tauriMocks.updateSettings
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const initial = snapshot(100);
    const { result } = renderHook(() => useSettings(initial));
    await act(async () => {});

    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = result.current.update({ windowScalePercent: 125 });
    });
    act(() => {
      b = result.current.update({ windowScalePercent: 150 });
    });

    await act(async () => {
      second.resolve(snapshot(150));
      await b;
    });
    await act(async () => {
      first.resolve(snapshot(125));
      await a;
    });

    expect(result.current.settings.windowScalePercent).toBe(150);
  });
});
