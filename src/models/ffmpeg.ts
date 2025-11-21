/* eslint-disable prettier/prettier */
import { EventEmitter } from "node:events";

let currentId = 0;

export class FFMPEG extends EventEmitter {
    readonly id: number;
    constructor() {
        super();
        this.id = currentId++;
    }

    async kill() {}
}
