// Which language the captain's sentences are shown in.
//
// **Filipino is the default, and that is a product decision, not a preference.**
// PRODUCT.md's captain "may read Filipino more comfortably than English", so the
// language he reads more comfortably is the one in the readable position. Before
// this file the display rendered English at full weight and Filipino underneath
// in smaller grey italics -- which is exactly the visual grammar of a translation
// afterthought, and PRODUCT.md explicitly promises the opposite.
//
// Both sentences stay on screen either way. The toggle changes which one is
// primary, not which one exists: a bilingual crew reads whichever it prefers,
// and nothing is hidden from anyone.
//
// Deliberately a tiny module-level store rather than React context. The value is
// one enum shared by four sibling render sites in one component tree; a context
// provider would be more ceremony than the problem deserves, and `useSyncExternal
// Store` gives correct behaviour under React 19's concurrent rendering for free.

import { useSyncExternalStore } from "react";

export type Language = "fil" | "en";

/** Filipino first. See the note above -- this is the load-bearing line. */
const DEFAULT: Language = "fil";

const STORAGE_KEY = "marine-ai.language";

let current: Language = DEFAULT;
const listeners = new Set<() => void>();

/** Read the persisted choice once, on the client only.
 *
 *  Guarded because this module is imported by a component tree that Next
 *  renders on the server first, where `localStorage` does not exist. Getting
 *  this wrong is a build-time crash, not a runtime warning. */
function hydrate(): void {
  if (typeof window === "undefined") return;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "fil" || stored === "en") current = stored;
}
hydrate();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Language {
  return current;
}

/** The server render must agree with the first client render, so it answers
 *  with the default rather than with whatever is in storage. */
function serverSnapshot(): Language {
  return DEFAULT;
}

export function setLanguage(next: Language): void {
  if (next === current) return;
  current = next;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, next);
  }
  for (const listener of listeners) listener();
}

export function toggleLanguage(): void {
  setLanguage(current === "fil" ? "en" : "fil");
}

/** The active language, re-rendering any component that reads it. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** The pair, ordered so the first is the one the captain is reading now. */
export function ordered(
  language: Language,
  en: string | null | undefined,
  fil: string | null | undefined,
): { primary: string | null; secondary: string | null } {
  const primary = (language === "fil" ? fil : en) ?? null;
  const secondary = (language === "fil" ? en : fil) ?? null;
  // A missing translation must not blank the panel: fall back to whichever
  // sentence exists rather than showing nothing at all.
  if (primary === null) return { primary: secondary, secondary: null };
  return { primary, secondary };
}

export const LANGUAGE_LABEL: Record<Language, string> = {
  fil: "FIL",
  en: "EN",
};
