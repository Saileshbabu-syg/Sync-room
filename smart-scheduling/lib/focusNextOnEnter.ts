import type { KeyboardEvent } from "react";

const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]), textarea:not([disabled]), button[role="combobox"]:not([disabled])';

// Fields reachable with the left/right arrows: the Enter-navigation fields plus
// checkboxes. Plain buttons (e.g. Confirm Booking) are left out on purpose.
const ARROW_FOCUSABLE = `${FOCUSABLE}, button[role="checkbox"]:not([disabled])`;

function visible(wrapper: HTMLElement, selector: string) {
  return Array.from(wrapper.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null
  );
}

// onKeyDown for a form wrapper: Enter in a text-like field moves focus to the
// next field instead of staying put. Buttons keep their own Enter behaviour, and
// a field with an open list (aria-expanded) keeps Enter for itself.
export function focusNextOnEnter(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) {
    return;
  }

  const target = e.target as HTMLElement;
  if (
    target.tagName !== "INPUT" ||
    (target as HTMLInputElement).type === "checkbox" ||
    target.getAttribute("aria-expanded") === "true"
  ) {
    return;
  }

  const fields = visible(e.currentTarget, FOCUSABLE);

  const next = fields[fields.indexOf(target) + 1];
  if (!next) return;

  e.preventDefault();
  next.focus();
}

// Left/right arrows move between selects and checkboxes. Text and date inputs
// keep the arrows for the caret and date segments, and open lists keep them for
// their own navigation.
export function focusAdjacentOnArrow(e: KeyboardEvent<HTMLElement>) {
  if (
    (e.key !== "ArrowLeft" && e.key !== "ArrowRight") ||
    e.defaultPrevented ||
    e.altKey ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey
  ) {
    return;
  }

  const target = e.target as HTMLElement;
  const role = target.getAttribute("role");

  if (
    (role !== "combobox" && role !== "checkbox") ||
    target.tagName !== "BUTTON" ||
    target.getAttribute("aria-expanded") === "true"
  ) {
    return;
  }

  const fields = visible(e.currentTarget, ARROW_FOCUSABLE);
  const next = fields[fields.indexOf(target) + (e.key === "ArrowRight" ? 1 : -1)];
  if (!next) return;

  e.preventDefault();
  next.focus();
}

// Both behaviours for one form wrapper.
export function formKeyNavigation(e: KeyboardEvent<HTMLElement>) {
  focusNextOnEnter(e);
  focusAdjacentOnArrow(e);
}
