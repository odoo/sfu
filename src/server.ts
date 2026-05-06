import * as resources from "#src/core/services/resources.ts";
import * as http from "#src/core/services/http.ts";
import * as auth from "#src/core/services/auth.ts";
import * as scheduler from "#src/recording/services/scheduler.ts";
import { Logger } from "#src/utils/utils.ts";
import { Channel } from "#src/core/models/channel.ts";

const logger = new Logger("SERVER", { logLevel: "all" });

async function run(): Promise<void> {
    logger.info(`starting server - PID: ${process.pid}`);
    auth.start();
    await resources.start();
    await http.start();
    await scheduler.start();
}

async function cleanup(): Promise<void> {
    await Channel.closeAll();
    http.close();
    await resources.close();
    scheduler.close();
    logger.info("cleanup complete");
}

const processHandlers = {
    exit: () => {
        void cleanup();
    },
    uncaughtException: (error: Error) => {
        logger.error(`uncaught exception ${error.name}: ${error.message} ${error.stack ?? ""}`);
    },
    SIGINT: cleanup,
    // 8, restarts the server
    SIGFPE: async () => {
        await cleanup();
        await run();
    },
    // 14, soft reset: only kicks all sessions, but keeps services alive
    SIGALRM: () => {
        void Channel.closeAll();
    },
    // 29, prints server stats
    SIGIO: async () => {
        let globalIncomingBitrate = 0;
        const proms: Promise<void>[] = [];
        for (const channel of Channel.records.values()) {
            proms.push(
                (async () => {
                    const {
                        sessionsStats: {
                            incomingBitRate: { audio, camera, screen, total },
                            count
                        }
                    } = await channel.getStats();
                    globalIncomingBitrate += total;
                    logger.info(`Channel ${channel.name}: ${count} sessions`);
                    logger.info(`-- audio: ${audio} bps`);
                    logger.info(`-- camera: ${camera} bps`);
                    logger.info(`-- screen: ${screen} bps`);
                    logger.info(`-- total: ${total} bps`);
                })()
            );
        }
        await Promise.all(proms);
        logger.info(`${Channel.records.size} channels total`);
        logger.info(`Global incoming bitrate: ${globalIncomingBitrate} bps`);
    }
};

// ==================== PROCESS ====================
process.title = "odoo_sfu";
for (const [signal, handler] of Object.entries(processHandlers)) {
    process.on(signal, handler);
}
await run();
// ==================== ======= ====================
