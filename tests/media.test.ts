import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

import * as media from "#src/services/media.ts";

describe("Media Service", () => {
    beforeEach(async () => {
        await media.start();
    });
    afterEach(() => {
        media.close();
    });
    test("dummy test", () => {
        expect(true).toBe(true);
    });
});
