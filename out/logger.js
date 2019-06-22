"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pluginId = "typescript-deno-plugin";
class Logger {
    constructor(logger) {
        this.logger = logger;
    }
    static forPlugin(info) {
        return new Logger(info.project.projectService.logger);
    }
    info(message) {
        this.logger.info(`[${pluginId}] ${JSON.stringify(message)}`);
    }
}
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map