import { expect, jest, test } from "@jest/globals";

import { waitFor } from "#tests/utils/utils.ts";

test("condition waits time out when Date.now is frozen", async () => {
    const dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    let watchdog: NodeJS.Timeout | undefined;
    try {
        const wait = waitFor(() => false, 10);
        const deadline = new Promise<void>((_, reject) => {
            watchdog = setTimeout(() => reject(new Error("condition wait did not time out")), 500);
        });
        await expect(Promise.race([wait, deadline])).rejects.toThrow(
            "timeout waiting for condition"
        );
    } finally {
        clearTimeout(watchdog);
        dateNowSpy.mockRestore();
    }
});
