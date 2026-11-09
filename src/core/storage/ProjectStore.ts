import type { Command, ProjectData } from '../engine/Command';

export interface ProjectSummary {
  id: string;
  name: string;
  styleId: string;
  formatId: string;
  createdAt: number;
  updatedAt: number;
  thumbnail?: Blob;
}

export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<ProjectData | undefined>;
  save(project: ProjectData, thumbnail?: Blob): Promise<void>;
  delete(id: string): Promise<void>;
}

const DB_NAME = 'art-style-studio';
const DB_VERSION = 1;
const META = 'projects';
const DATA = 'commands';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** IndexedDB store. Metadata (with thumbnail) and the command log are kept apart so the gallery loads fast. */
class IdbProjectStore implements ProjectStore {
  constructor(private readonly db: IDBDatabase) {}

  async list(): Promise<ProjectSummary[]> {
    const tx = this.db.transaction(META, 'readonly');
    const all = await req(tx.objectStore(META).getAll() as IDBRequest<ProjectSummary[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<ProjectData | undefined> {
    const tx = this.db.transaction([META, DATA], 'readonly');
    const meta = await req(tx.objectStore(META).get(id) as IDBRequest<ProjectSummary | undefined>);
    if (!meta) return undefined;
    const data = await req(tx.objectStore(DATA).get(id) as IDBRequest<{ id: string; commands: Command[] } | undefined>);
    const { thumbnail: _thumb, ...rest } = meta;
    return { ...rest, commands: data?.commands ?? [] };
  }

  async save(project: ProjectData, thumbnail?: Blob): Promise<void> {
    const tx = this.db.transaction([META, DATA], 'readwrite');
    const metaStore = tx.objectStore(META);
    const existing = await req(metaStore.get(project.id) as IDBRequest<ProjectSummary | undefined>);
    const { commands, ...meta } = project;
    metaStore.put({ ...meta, thumbnail: thumbnail ?? existing?.thumbnail } satisfies ProjectSummary);
    tx.objectStore(DATA).put({ id: project.id, commands });
    await done(tx);
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction([META, DATA], 'readwrite');
    tx.objectStore(META).delete(id);
    tx.objectStore(DATA).delete(id);
    await done(tx);
  }
}

/** Fallback when IndexedDB is unavailable (some private-browsing modes). */
export class MemoryProjectStore implements ProjectStore {
  private readonly items = new Map<string, { data: ProjectData; thumbnail?: Blob }>();
  async list(): Promise<ProjectSummary[]> {
    return [...this.items.values()]
      .map(({ data: { commands: _c, ...meta }, thumbnail }) => ({ ...meta, thumbnail }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(id: string): Promise<ProjectData | undefined> {
    return this.items.get(id)?.data;
  }
  async save(project: ProjectData, thumbnail?: Blob): Promise<void> {
    const prev = this.items.get(project.id);
    this.items.set(project.id, { data: project, thumbnail: thumbnail ?? prev?.thumbnail });
  }
  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}

export async function openProjectStore(): Promise<ProjectStore> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
    };
    return new IdbProjectStore(await req(open));
  } catch (e) {
    console.warn('IndexedDB unavailable, projects will not persist.', e);
    return new MemoryProjectStore();
  }
}
