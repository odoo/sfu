import { EventEmitter } from "node:events";
import type { SpawnOptions, ChildProcess } from "node:child_process";
import { Readable, Writable, PassThrough } from "node:stream";
import { jest } from "@jest/globals";
import { mockFs } from "./mockFileSystem.ts";

export type ChildProcessLike = {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: number | string) => boolean;
    killed: boolean;
    pid: number;
} & ChildProcess;

export class MockChildProcess extends EventEmitter implements ChildProcess {
    stdin: Writable | null = new Writable({ write: (c, e, cb) => cb() });
    stdout: Readable | null = new Readable({ read() {} });
    stderr: Readable | null = new Readable({ read() {} });
    stdio: [
        Writable | null,
        Readable | null,
        Readable | null,
        Writable | Readable | null | undefined,
        Writable | Readable | null | undefined
    ] = [this.stdin, this.stdout, this.stderr, null, null];
    killed: boolean = false;
    pid: number = 123;
    connected: boolean = false;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    spawnargs: string[];
    spawnfile: string;

    constructor(command: string, args: string[]) {
        super();
        this.spawnfile = command;
        this.spawnargs = args;

        if (command === "ffmpeg") {
            this._simulateFfmpeg(args);
        } else if (command === "ffprobe") {
            this._simulateFfprobe(args);
        }
    }

    kill(signal?: NodeJS.Signals | number): boolean {
        this.killed = true;
        this.emit("close", null, signal);
        return true;
    }

    [Symbol.dispose](): void {
        this.kill();
    }

    send(message: unknown, sendHandle?: unknown, options?: unknown, callback?: unknown): boolean {
        return false;
    }
    disconnect(): void {}
    unref(): void {}
    ref(): void {}

    private _simulateFfmpeg(args: string[]) {
        const outputFile = args[args.length - 1];
        if (!outputFile) {
            return;
        }
        setTimeout(() => {
            if (!this.killed) {
                mockFs.write(outputFile, "mock-ffmpeg-output-content");
                this.emit("close", 0);
            }
        }, 10);
    }

    private _simulateFfprobe(args: string[]) {
        const inputFile = args[args.length - 1];
        if (!inputFile) {
            setTimeout(() => this.emit("close", 1), 5);
            return;
        }
        const fileExists = mockFs.exists(inputFile);
        setTimeout(() => {
            if (!this.killed) {
                if (fileExists) {
                    this.stdout?.push("vp8\n");
                    this.stdout?.push(null);
                    this.emit("close", 0);
                } else {
                    this.emit("close", 1);
                }
            }
        }, 5);
    }
}

export const mockSpawn = jest.fn((command: string, args: string[], options?: unknown) => {
    return new MockChildProcess(command, args);
});

export function mockFfmpeg() {
    jest.mock("node:child_process", () => {
        const original = jest.requireActual("node:child_process") as {
            spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;
        };
        return {
            ...original,
            spawn: (command: string, args: string[], options: SpawnOptions): ChildProcessLike => {
                if (command === "ffmpeg" || command === "ffprobe") {
                    return mockSpawn(command, args, options) as unknown as ChildProcessLike;
                }
                return original.spawn(command, args, options);
            }
        };
    });
}
