import type { KeyboardEvent } from "react";

const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]), textarea:not([disabled]), button[role="combobox"]:not([disabled])';

// onKeyDown for a form wrapper: Enter in a text-like field moves focus to the
// next field instead of staying put. Buttons keep their own Enter behaviour.
export function focusNextOnEnter(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) {
    return;
  }

  const target = e.target as HTMLElement;
  if (target.tagName !== "INPUT" || (target as HTMLInputElement).type === "checkbox") {
    return;
  }

  const fields = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)
  ).filter((el) => el.offsetParent !== null);

  const next = fields[fields.indexOf(target) + 1];
  if (!next) return;

  e.preventDefault();
  next.focus();
}
