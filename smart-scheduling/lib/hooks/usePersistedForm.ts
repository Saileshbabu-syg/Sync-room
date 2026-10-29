"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

const subscribeToNothing = () => () => {};

// Form state that is seeded from sessionStorage (when the user comes "back"
// to a half-filled booking form) without calling setState inside an effect:
// the saved value is read through useSyncExternalStore — which is hydration
// safe, the server render always uses `initial` — and local edits layer on
// top of it.
//
// `initial` must be a stable (module-level) object.
export function usePersistedForm<T extends object>(key: string, initial: T) {
  const saved = useSyncExternalStore(
    subscribeToNothing,
    () => {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null
  );

  let base = initial;

  if (saved) {
    try {
      base = { ...initial, ...(JSON.parse(saved) as Partial<T>) };
    } catch {
      base = initial;
    }
  }

  const [edited, setEdited] = useState<T | null>(null);

  const value = edited ?? base;

  const update = useCallback(
    (updater: (previous: T) => T) =>
      setEdited((previous) => updater(previous ?? base)),
    // `base` is derived from `saved`, which only changes on a new session read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved]
  );

  return [value, update] as const;
}
