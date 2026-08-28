import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";

import { describe, expect, test } from "@jest/globals";

describe("Server", () => {
    test("cleans up when HTTP startup fails", async () => {
        const occupiedPort = createServer();
        occupiedPort.listen(0, "127.0.0.1");
        await once(occupiedPort, "listening");
        const { port } = occupiedPort.address() as AddressInfo;
        let serverProcess: ChildProcess | undefined;

        try {
            const output: string[] = [];
            serverProcess = spawn(
                process.execPath,
                ["--experimental-transform-types", "./src/server.ts"],
                {
                    cwd: process.cwd(),
                    env: { ...process.env, LOG_LEVEL: "info", PORT: String(port) }
                }
            );
            serverProcess.stdout?.on("data", (data) => output.push(String(data)));
            serverProcess.stderr?.on("data", (data) => output.push(String(data)));

            const [code, signal] = await once(serverProcess, "close", {
                signal: AbortSignal.timeout(5_000)
            });
            const logs = output.join("");
            expect(signal).toBeNull();
            expect(code).toBe(1);
            expect(logs).toContain("initialized 1 mediasoup workers");
            expect(logs).toContain("EADDRINUSE");
            expect(logs).toContain("cleanup complete");
        } finally {
            if (
                serverProcess &&
                serverProcess.exitCode === null &&
                serverProcess.signalCode === null
            ) {
                const close = once(serverProcess, "close");
                serverProcess.kill("SIGKILL");
                await close;
            }
            await new Promise<void>((resolve, reject) => {
                occupiedPort.close((error) => (error ? reject(error) : resolve()));
            });
        }
    }, 10_000);
});
