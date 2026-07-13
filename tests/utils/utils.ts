import { jest } from "@jest/globals";

/**
 * Sets the environment variables and resets the modules to force a reload of the configuration.
 * Returns a function to restore the environment variables and reset the modules again.
 *
 * @param config - The environment variables to set. Pass `undefined` to unset a variable.
 * @returns A function to restore the environment.
 */
export function withMockEnv(config: Record<string, string | undefined>): () => void {
    const originalEnv = { ...process.env };
    for (const [key, value] of Object.entries(config)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    jest.resetModules();

    return () => {
        for (const key in process.env) {
            delete process.env[key];
        }
        Object.assign(process.env, originalEnv);
        jest.resetModules();
    };
}

export async function waitFor(predicate: () => unknown, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("timeout waiting for condition");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
