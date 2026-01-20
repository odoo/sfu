import { jest } from "@jest/globals";
import path from "node:path";

/**
 * Mock file system to avoid interacting with the disk during tests.
 */
export class MockFileSystem {
    private files = new Map<string, string>();
    private dirs = new Set<string>();

    constructor() {
        this.dirs.add("/");
    }

    reset() {
        this.files.clear();
        this.dirs.clear();
        this.dirs.add("/");
    }

    stat(path: string): { size: number } {
        return {
            size: 999
        };
    }

    createReadStream(path: string) {
        return "";
    }

    async readdir(dirPath: string, options?: { withFileTypes?: boolean }): Promise<unknown[]> {
        const normalizedDir = path.resolve(dirPath);
        const entries: unknown[] = [];

        for (const d of this.dirs) {
            if (path.dirname(d) === normalizedDir && d !== normalizedDir) {
                const name = path.basename(d);
                if (options?.withFileTypes) {
                    entries.push({
                        name,
                        isDirectory: () => true,
                        isFile: () => false
                    });
                } else {
                    entries.push(name);
                }
            }
        }
        return entries;
    }

    async readFile(filePath: string, encoding?: string): Promise<string> {
        const normalizedPath = path.resolve(filePath);
        if (!this.files.has(normalizedPath)) {
            const err = new Error(
                `ENOENT: no such file or directory, open '${normalizedPath}'`
            ) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
        }
        return this.files.get(normalizedPath)!;
    }

    async access(filePath: string): Promise<void> {
        const normalizedPath = path.resolve(filePath);
        if (!this.files.has(normalizedPath) && !this.dirs.has(normalizedPath)) {
            const err = new Error(
                `ENOENT: no such file or directory, access '${normalizedPath}'`
            ) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
        }
    }

    async rm(targetPath: string, options?: { recursive?: boolean }): Promise<void> {
        const normalized = path.resolve(targetPath);

        if (this.files.has(normalized)) {
            this.files.delete(normalized);
            return;
        }

        if (this.dirs.has(normalized)) {
            if (options?.recursive) {
                for (const f of this.files.keys()) {
                    if (f.startsWith(normalized + path.sep) || f === normalized) {
                        this.files.delete(f);
                    }
                }
                for (const d of this.dirs) {
                    if (d.startsWith(normalized + path.sep) || d === normalized) {
                        this.dirs.delete(d);
                    }
                }
            } else {
                this.dirs.delete(normalized);
            }
            return;
        }
    }

    write(filePath: string, content: string) {
        const normalized = path.resolve(filePath);
        this.files.set(normalized, content);
        let parent = path.dirname(normalized);
        while (parent && parent !== "/" && parent !== ".") {
            this.dirs.add(parent);
            parent = path.dirname(parent);
        }
        this.dirs.add(path.dirname(normalized));
    }

    mkdir(dirPath: string, options?: { recursive?: boolean }) {
        const normalized = path.resolve(dirPath);
        this.dirs.add(normalized);
        if (options?.recursive) {
            let parent = path.dirname(normalized);
            while (parent && parent !== "/" && parent !== ".") {
                this.dirs.add(parent);
                parent = path.dirname(parent);
            }
        }
    }

    rmSync(targetPath: string, options?: { recursive?: boolean; force?: boolean }): void {
        const normalized = path.resolve(targetPath);

        if (this.files.has(normalized)) {
            this.files.delete(normalized);
            return;
        }

        if (this.dirs.has(normalized)) {
            if (options?.recursive) {
                for (const f of this.files.keys()) {
                    if (f.startsWith(normalized + path.sep) || f === normalized) {
                        this.files.delete(f);
                    }
                }
                for (const d of this.dirs) {
                    if (d.startsWith(normalized + path.sep) || d === normalized) {
                        this.dirs.delete(d);
                    }
                }
            } else {
                this.dirs.delete(normalized);
            }
            return;
        }

        if (!options?.force) {
            const err = new Error(
                `ENOENT: no such file or directory, rm '${normalized}'`
            ) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
        }
    }

    rename(oldPath: string, newPath: string) {
        const normalizedOld = path.resolve(oldPath);
        const normalizedNew = path.resolve(newPath);

        if (this.dirs.has(normalizedOld)) {
            this.dirs.delete(normalizedOld);
            this.dirs.add(normalizedNew);

            const oldPrefix = normalizedOld + path.sep;
            const newPrefix = normalizedNew + path.sep;

            for (const [f, c] of this.files) {
                if (f.startsWith(oldPrefix)) {
                    this.files.delete(f);
                    this.files.set(f.replace(oldPrefix, newPrefix), c);
                }
            }
            for (const d of Array.from(this.dirs)) {
                if (d.startsWith(oldPrefix)) {
                    this.dirs.delete(d);
                    this.dirs.add(d.replace(oldPrefix, newPrefix));
                }
            }
            return;
        }

        const err = new Error(
            `ENOENT: no such file or directory, rename '${normalizedOld}' -> '${normalizedNew}'`
        ) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
    }

    exists(filePath: string): boolean {
        const normalized = path.resolve(filePath);
        return this.files.has(normalized) || this.dirs.has(normalized);
    }
}

export const mockFs = new MockFileSystem();

export const mockFsModule = {
    readdir: jest.fn((path: string, opts: unknown) =>
        mockFs.readdir(path, opts as { withFileTypes?: boolean })
    ),
    stat: jest.fn((path: string) => mockFs.stat(path)),
    readFile: jest.fn((path: string, enc: unknown) => mockFs.readFile(path, enc as string)),
    access: jest.fn((path: string) => mockFs.access(path)),
    rm: jest.fn((path: string, opts: unknown) =>
        mockFs.rm(path, opts as { recursive?: boolean; force?: boolean })
    ),
    mkdir: jest.fn((path: string, opts: { recursive?: boolean }) =>
        Promise.resolve(mockFs.mkdir(path, opts))
    ),
    writeFile: jest.fn((path: string, content: string) =>
        Promise.resolve(mockFs.write(path, content))
    ),
    rename: jest.fn((oldPath: string, newPath: string) =>
        Promise.resolve(mockFs.rename(oldPath, newPath))
    ),
    unlink: jest.fn((path: string) => mockFs.rm(path))
};

export const mockFsSyncModule = {
    createReadStream: jest.fn((path: string) => mockFs.createReadStream(path)),
    rmSync: jest.fn((path: string, opts: unknown) =>
        mockFs.rmSync(path, opts as { recursive?: boolean; force?: boolean })
    ),
    mkdirSync: jest.fn((path: string) => mockFs.mkdir(path))
};

export function mockNodeFS() {
    jest.mock("node:fs", () => {
        const { mockFsSyncModule } = jest.requireActual("#tests/utils/mockFileSystem.ts") as {
            mockFsSyncModule: typeof import("#tests/utils/mockFileSystem").mockFsSyncModule;
        };
        return {
            ...(jest.requireActual("node:fs") as Record<string, unknown>),
            createReadStream: mockFsSyncModule.createReadStream,
            rmSync: mockFsSyncModule.rmSync,
            mkdirSync: mockFsSyncModule.mkdirSync
        };
    });
    jest.mock("node:fs/promises", () => {
        const { mockFsModule } = jest.requireActual("#tests/utils/mockFileSystem.ts") as {
            mockFsModule: typeof import("#tests/utils/mockFileSystem").mockFsModule;
        };
        return mockFsModule;
    });
}
