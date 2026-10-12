import type { Item, Labels } from "./types";

// Local store of every labelled post and comment. Written by the background worker
// and read by the settings page; both run on the extension's origin.

export interface StoredItem {
  id: string;
  labelledAt: string; // indexed
  item: Item; // `body` is as sent to Jev
  bodyCut: boolean; // true when the body was longer than MAX_BODY_CHARS and was cut
  labels: Labels;
  model: string;
  inputTokens: number;
}

const DB_NAME = "reddit-pain";
const STORE = "items";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" }).createIndex("labelledAt", "labelledAt");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function store(mode: IDBTransactionMode) {
  return (await open()).transaction(STORE, mode).objectStore(STORE);
}

export async function getItem(id: string): Promise<StoredItem | undefined> {
  return done((await store("readonly")).get(id));
}

export async function putItem(record: StoredItem): Promise<void> {
  await done((await store("readwrite")).put(record));
}

export async function countItems(): Promise<number> {
  return done((await store("readonly")).count());
}

export async function recentItems(limit: number): Promise<StoredItem[]> {
  const index = (await store("readonly")).index("labelledAt");
  return new Promise((resolve, reject) => {
    const out: StoredItem[] = [];
    const req = index.openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve(out);
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearItems(): Promise<void> {
  await done((await store("readwrite")).clear());
}
