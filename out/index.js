"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// modified from https://github.com/Microsoft/typescript-tslint-plugin
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const merge_deep_1 = __importDefault(require("merge-deep"));
const mock_require_1 = __importDefault(require("mock-require"));
const tsconfig_1 = require("tsconfig");
const logger_1 = require("./logger");
const shared_1 = require("./shared");
let logger;
const importMapCache = new Map();
module.exports = function init({ typescript }) {
    // Make sure Deno imports the correct version of TS
    mock_require_1.default("typescript", typescript);
    // see https://github.com/denoland/deno/blob/2debbdacb935cfe1eb7bb8d1f40a5063b339d90b/js/compiler.ts#L159-L170
    const OPTIONS = {
        allowJs: true,
        checkJs: true,
        esModuleInterop: true,
        module: typescript.ModuleKind.ESNext,
        moduleResolution: typescript.ModuleResolutionKind.NodeJs,
        noEmit: true,
        outDir: "$deno$",
        removeComments: true,
        resolveJsonModule: true,
        sourceMap: true,
        target: typescript.ScriptTarget.ESNext,
        typeRoots: [],
    };
    let transformFromImportMap;
    let projectDirectory;
    return {
        create(info) {
            logger = logger_1.Logger.forPlugin(info);
            logger.info("Create.");
            // ref https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API#customizing-module-resolution
            const resolveModuleNames = info.languageServiceHost.resolveModuleNames;
            if (resolveModuleNames === undefined) {
                logger.info("resolveModuleNames is undefined.");
                return info.languageService;
            }
            info.languageServiceHost.resolveModuleNames = (moduleNames, containingFile, reusedNames, redirectedReference) => {
                logger.info("Resolved Module Names.");
                projectDirectory = info.project.getCurrentDirectory();
                transformFromImportMap = makeTransformFromImportMap(projectDirectory);
                moduleNames = moduleNames.map(transformFromImportMap).map(stripExtNameDotTs).map(convertRemoteToLocalCache);
                return resolveModuleNames.call(info.languageServiceHost, moduleNames, containingFile, reusedNames, redirectedReference);
            };
            const getCompilationSettings = info.languageServiceHost.getCompilationSettings;
            info.languageServiceHost.getCompilationSettings = () => {
                const projectConfig = getCompilationSettings.call(info.languageServiceHost);
                const compilationSettings = merge_deep_1.default(OPTIONS, projectConfig);
                logger.info(`compilationSettings:${JSON.stringify(compilationSettings)}`);
                return compilationSettings;
            };
            const getScriptFileNames = info.languageServiceHost.getScriptFileNames;
            info.languageServiceHost.getScriptFileNames = () => {
                const scriptFileNames = getScriptFileNames.call(info.languageServiceHost);
                const denoDtsPath = getDtsPathForVscode(info) || getGlobalDtsPath() || getLocalDtsPath(info);
                if (denoDtsPath) {
                    scriptFileNames.push(denoDtsPath);
                }
                logger.info(`dts path: ${denoDtsPath}`);
                return scriptFileNames;
            };
            const getCompletionEntryDetails = info.languageService.getCompletionEntryDetails;
            info.languageService.getCompletionEntryDetails = (fileName, position, name, formatOptions, source, preferences) => {
                const details = getCompletionEntryDetails.call(info.languageService, fileName, position, name, formatOptions, source, preferences);
                if (details) {
                    if (details.codeActions && details.codeActions.length) {
                        for (const ca of details.codeActions) {
                            for (const change of ca.changes) {
                                if (!change.isNewFile) {
                                    for (const tc of change.textChanges) {
                                        tc.newText = tc.newText.replace(/^(import .* from ['"])(\..*)(['"];\n)/i, "$1$2.ts$3");
                                    }
                                }
                            }
                        }
                    }
                }
                return details;
            };
            return info.languageService;
        },
        onConfigurationChanged(config) {
            if (projectDirectory) {
                transformFromImportMap = makeTransformFromImportMap(projectDirectory);
            }
            logger.info(`onConfigurationChanged: ${JSON.stringify(config)}`);
        }
    };
};
function getImportMap(filePath) {
    const fileStats = fs.statSync(filePath);
    const cacheKey = `${filePath}-${fileStats.mtimeMs}`;
    const isCached = importMapCache.has(cacheKey);
    let workingImportMap;
    if (!isCached) {
        const importMapFile = fs.readFileSync(filePath, { encoding: "utf-8" });
        workingImportMap = JSON.parse(importMapFile);
        importMapCache.set(cacheKey, workingImportMap);
    }
    else {
        workingImportMap = importMapCache.get(cacheKey);
    }
    return workingImportMap;
}
function makeTransformFromImportMap(projectDirectory) {
    const tsconfigPath = tsconfig_1.resolveSync(projectDirectory);
    logger.info(`config path: ${tsconfigPath}`);
    if (tsconfigPath !== undefined) {
        const tsconfig = tsconfig_1.readFileSync(tsconfigPath);
        const denoOptions = tsconfig.denoOptions;
        if (denoOptions && denoOptions.importMap) {
            const tsconfigDirectory = path.dirname(tsconfigPath);
            const importMapPath = path.resolve(tsconfigDirectory, denoOptions.importMap);
            const importMap = getImportMap(importMapPath);
            return (moduleName) => {
                logger.info("hitmf");
                const imports = importMap.imports;
                const importKeys = Object.keys(imports);
                for (const key of importKeys) {
                    if (moduleName.startsWith(key)) {
                        const strippedModuleName = moduleName.substring(key.length);
                        const realModuleName = imports[key] + strippedModuleName;
                        logger.info(realModuleName);
                        return realModuleName;
                    }
                }
                return moduleName;
            };
        }
    }
    return (moduleName) => moduleName;
}
function getModuleWithQueryString(moduleName) {
    let name = moduleName;
    for (const index = name.indexOf("?"); index !== -1; name = name.substring(index + 1)) {
        if (name.substring(0, index).endsWith(".ts")) {
            const cutLength = moduleName.length - name.length;
            return moduleName.substring(0, index + cutLength);
        }
    }
}
function stripExtNameDotTs(moduleName) {
    const moduleWithQuery = getModuleWithQueryString(moduleName);
    if (moduleWithQuery) {
        return moduleWithQuery;
    }
    if (!moduleName.endsWith(".ts")) {
        return moduleName;
    }
    const name = moduleName.slice(0, -3);
    logger.info(`strip "${moduleName}" to "${name}".`);
    return name;
}
function convertRemoteToLocalCache(moduleName) {
    if (!moduleName.startsWith("http://") && !moduleName.startsWith("https://")) {
        return moduleName;
    }
    const denoDir = shared_1.getDenoDir();
    // "https://deno.land/x/std/log/mod" to "$DENO_DIR/deps/https/deno.land/x/std/log/mod" (no ".ts" because stripped)
    const name = path.resolve(denoDir, "deps", moduleName.replace("://", "/"));
    const redirectedName = fallbackHeader(name);
    logger.info(`convert "${moduleName}" to "${redirectedName}".`);
    return redirectedName;
}
/**
 * If moduleName is not found, recursively search for headers and "redirect_to" property.
 */
function fallbackHeader(modulePath) {
    const validPath = modulePath.endsWith(".ts") ? modulePath : `${modulePath}.ts`;
    if (fs.existsSync(validPath)) {
        return modulePath;
    }
    const headersPath = `${validPath}.headers.json`;
    if (fs.existsSync(headersPath)) {
        const headers = JSON.parse(fs.readFileSync(headersPath, { encoding: "utf-8" }));
        logger.info(`redirect "${modulePath}" to "${headers.redirect_to}".`);
        // TODO: avoid Circular
        return convertRemoteToLocalCache(stripExtNameDotTs(headers.redirect_to));
    }
    return modulePath;
}
function getDtsPathForVscode(info) {
    const bundledDtsPath = info.config.dtsPath;
    if (bundledDtsPath && fs.existsSync(bundledDtsPath)) {
        return bundledDtsPath;
    }
    return undefined;
}
function getGlobalDtsPath() {
    const denoDir = shared_1.getDenoDir();
    const globalDtsPath = path.resolve(denoDir, "lib.deno_runtime.d.ts");
    if (fs.existsSync(globalDtsPath)) {
        return globalDtsPath;
    }
    return undefined;
}
function getLocalDtsPath(info) {
    const localDtsPath = path.resolve(info.project.getCurrentDirectory(), "node_modules", "typescript-deno-plugin", "lib", "lib.deno_runtime.d.ts");
    if (fs.existsSync(localDtsPath)) {
        return localDtsPath;
    }
    return undefined;
}
//# sourceMappingURL=index.js.map