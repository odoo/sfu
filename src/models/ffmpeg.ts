import { EventEmitter } from "node:events";

let currentId = 0;

export class FFMPEG extends EventEmitter {
    id: number;
    constructor() {
        super();
        this.id = currentId++;
    }

    async kill() {}
}
