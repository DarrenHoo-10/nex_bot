// Annotations of one conversation. In production they live in Core (loaded
// per session, saved optimistically: a failed save puts the note back the way
// it was and says so); the isolated review fixture keeps its sessionStorage.
// Saves run one after another so an edit never overtakes the create it follows.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CliSessionKey } from "../../../shared/cli-agents";
import { CliApiError, cliErrorText, createNote, deleteNote, fetchNotes, updateNote, type CliNote } from "./api";
import { readNotes, storeNotes, type Note } from "./WorkbenchReview";

export function useNotes(key: CliSessionKey, persisted: boolean) {
  const [notes, setNotes] = useState<Note[]>(() => (persisted ? [] : readNotes(key)));
  const [error, setError] = useState("");
  const current = useRef<Note[]>(notes);
  /** Core's version of each note it has saved */
  const versions = useRef(new Map<string, number>());
  const chain = useRef<Promise<void>>(Promise.resolve());
  const failed = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const show = useCallback((next: Note[]) => {
    current.current = next;
    if (live.current) setNotes(next);
  }, []);
  const remember = useCallback((saved: readonly CliNote[]) => {
    for (const note of saved) versions.current.set(note.id, note.version);
  }, []);

  /** One save, queued behind the ones before it. */
  const enqueue = useCallback((work: () => Promise<void>, revert: () => void) => {
    chain.current = chain.current.then(async () => {
      try {
        await work();
      } catch (cause) {
        failed.current = true;
        revert();
        if (live.current) setError(cliErrorText(cause, "注释保存失败"));
        // someone else changed it: show what Core has
        if (cause instanceof CliApiError && cause.status === 409) {
          const fresh = await fetchNotes(key).catch(() => null);
          if (fresh) { remember(fresh); show(fresh); }
        }
      }
    });
  }, [key, show, remember]);

  const update = useCallback((next: Note[]) => {
    if (!persisted) {
      show(next);
      storeNotes(key, next);
      return;
    }
    const before = current.current;
    show(next);
    setError("");
    for (const note of next.filter((entry) => !before.some((old) => old.id === entry.id))) {
      enqueue(async () => {
        const saved = await createNote(key, {
          id: note.id, message: note.message, quote: note.quote, body: note.body, num: note.num,
          ...(note.end > note.start ? { start: note.start, end: note.end } : {}),
        });
        remember([saved]);
      }, () => show(current.current.filter((entry) => entry.id !== note.id)));
    }
    for (const note of next.filter((entry) => before.some((old) => old.id === entry.id && old.body !== entry.body))) {
      const previous = before.find((old) => old.id === note.id)!;
      enqueue(async () => {
        const version = versions.current.get(note.id);
        if (version === undefined) return; // its create failed: nothing to edit
        remember([await updateNote(note.id, version, note.body)]);
      }, () => show(current.current.map((entry) => (entry.id === note.id ? { ...entry, body: previous.body } : entry))));
    }
    for (const note of before.filter((old) => !next.some((entry) => entry.id === old.id))) {
      enqueue(async () => {
        const version = versions.current.get(note.id);
        if (version === undefined) return; // never reached Core
        await deleteNote(note.id, version);
        versions.current.delete(note.id);
      }, () => show([...current.current, note].sort((a, b) => a.num - b.num)));
    }
  }, [persisted, key, show, remember, enqueue]);

  // load this session's notes; sessionStorage notes of an older build move up once
  useEffect(() => {
    if (!persisted) return;
    let cancelled = false;
    void fetchNotes(key).then((saved) => {
      if (cancelled) return;
      remember(saved);
      const added = current.current.filter((note) => !saved.some((entry) => entry.id === note.id));
      show([...saved, ...added]);
      const legacy = readNotes(key).filter((note) => !saved.some((entry) => entry.id === note.id) && !added.some((entry) => entry.id === note.id));
      if (!legacy.length) return;
      failed.current = false;
      update([...current.current, ...legacy]);
      chain.current = chain.current.then(() => { if (!failed.current) storeNotes(key, []); });
    }, (cause) => {
      if (!cancelled && live.current) setError(cliErrorText(cause, "注释读取失败"));
    });
    return () => { cancelled = true; };
  }, [persisted, key, show, remember, update]);

  return { notes, update, error, dismissError: () => setError("") };
}
