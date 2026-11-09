"use client";

import { useEffect, useState } from "react";

// Whether the signed-in person's group may book meetings that end the next day
// (application switch and group choice combined). Advisory only: it decides
// whether the end-time list offers "next day" times; the server enforces the
// rule on every booking, move and series edit.
export function useAllowOvernight(): boolean {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/booking-policy")
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (!cancelled) setAllowed(json?.policy?.allowOvernight === true);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return allowed;
}
