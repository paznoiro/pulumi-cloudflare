import * as fs from 'fs';
import {CLIOptions, ExecuteOptions, ParsedResource, PROP} from './types.js';
import PropertiesReader from 'properties-reader';
import { parseArgs } from 'util';
import { execa } from 'execa';
import { isCancel, text, TextOptions } from "@clack/prompts";
import { Config } from '@pulumi/pulumi';
import * as path from 'path';
import { dirname, resolve } from 'path';
import { fileURLToPath } from "url";
import { input } from '@pulumi/cloudflare/types/index.js';

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const PULUMI_DIR = path.join(PROJECT_DIR, "pulumi");

console.log(`🗂 projectRoot:${PROJECT_DIR} \n🗂 pulumiDir: ${PULUMI_DIR}`)
export const IGNORE_PROP_LIST: ReadonlySet<string> = new Set([
    PROP.CLOUDFLARE_RESOURCE,
    PROP.CLOUDFLARE_API_TOKEN,
    PROP.CLOUDFLARE_ACCOUNT_ID,
    PROP.PROJECT_ID
]);

export const SECRET_PATTERN_LIST = [
    'secret',
    'key',
    'password',
    'token',
    'credential',
    'apikey',
    'api_key',
];


export async function executeRaw(
    command: string, args: string[] = [],
    options: ExecuteOptions = { stdoutPipe: false }
): Promise<string | undefined> {
    console.log(`  🏄‍♂️ ${command} ${args.join(' ')}`);
    const env = { ...process.env, ...options.env };
    try {
        const { stdout } = await execa(command, args, {
            cwd: options.cwd,
            env: env,
            timeout: 300000,
            killSignal: 'SIGTERM',
            shell: options.shell,
            input: options.input,
            stdin: options.input !== undefined ? 'pipe' : 'inherit',
            stdout: options.stdoutPipe ? 'pipe' : 'inherit',
            stderr: 'inherit',

        });
        return stdout;
    } catch (error: any) {
        if (error.stdout) console.log(error.stdout);
        if (error.stderr) console.error(error.stderr);
        throw new Error(`Command failed: ${command} - ${error.message}`);
    }
}

export async function executeJson(
    command: string, args: string[] = [], options: ExecuteOptions): Promise<any> {
    const execOptions: ExecuteOptions = {
        ...options,
        stdoutPipe: true,
    };
    let output = await executeRaw(command, args, execOptions);
    return JSON.parse(output || '{}');
}

export async function pulumiConfig(key: string, value: string, isSecret = false, options: ExecuteOptions): Promise<void> {
    const custoptions = {
        ...options,
        input: value,
        stdoutPipe: true
    }
    const secretFlag = isSecret ? '--secret' : '--plaintext';
    await executeRaw('pulumi', ['config', 'set', key, secretFlag, '--cwd', PULUMI_DIR], custoptions);
}

export async function pulumiUp(options: any): Promise<void> {
    await executeRaw(`pulumi`, ['up', '--yes', '--cwd', PULUMI_DIR, '--skip-preview'], options);
}
export function isSecret(key: string): boolean {
    const lowerKey = key.toLowerCase();
    return SECRET_PATTERN_LIST.some(keyword =>
        lowerKey.includes(keyword)
    );
}
export function getConfigKey(rawKey: string): { snakeKey: string; camelKey: string } {
    const cleanKey = rawKey.includes(":") ? rawKey.split(":")[1] : rawKey;
    return {snakeKey:camelToSnake(cleanKey),camelKey: cleanKey};
}

export function cleanArg(arg: string | undefined): string | undefined {
    if (!arg) return arg;
    return arg.replace(/^["']|["']$/g, '');
}

export function propertyReader(filePath: string): PropertiesReader.Reader {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Properties file not found: ${filePath}`);
    }
    return PropertiesReader(filePath);
}


export function argsOf(): CLIOptions {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        options: {
            stack: { type: 'string', short: 's' },
            properties: { type: 'string', short: 'p' },
            auto: { type: 'boolean', short: 'y' },
        },
        allowPositionals: true
    });

    return {
        stackName: cleanArg(values.stack || positionals[0]),
        propertiesFile: cleanArg(values.properties),
        auto: values.auto || false
    };
}

export function extractStackName(baseUrl: string): string {
    try {
        const url = new URL(baseUrl);
        return url.hostname.replace(/\./g, '-');
    } catch {
        throw new Error(`Invalid BASE_URL format: ${baseUrl}`);
    }
}

export function snakeToCamel(str: string): string {
    return str.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

// camelCase → UPPER_SNAKE_CASE
export function camelToSnake(str: string): string {
    return str
        .replace(/([A-Z])/g, '_$1')
        .toUpperCase()
        .replace(/^_/, '');
}

export function errorLog(str: string): string {
    console.error(`❌ ${str}`);
    process.exit(1);
}

export async function validatePassPhrase(auto: boolean, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
    if (env.PULUMI_CONFIG_PASSPHRASE || env.PULUMI_CONFIG_PASSPHRASE_FILE) {
        return env.PULUMI_CONFIG_PASSPHRASE;
    }

    if (auto) {
        errorLog('PULUMI_CONFIG_PASSPHRASE environment variable is not set');
    }

    return await prompt({
        message: 'Enter PULUMI_CONFIG_PASSPHRASE:',
        placeholder: 'Enter your Pulumi stack passphrase'
    });
}

export async function prompt(options: TextOptions): Promise<string> {
    const userResponse = await text(options);
    if (isCancel(userResponse)) {
        process.exit(0);
    }
    return userResponse;
}

export async function isStackValid(stackName: string, options: ExecuteOptions): Promise<boolean> {

    let stackList: any = await executeJson('pulumi', ['stack', 'ls', '--cwd', PULUMI_DIR, '--json'], options);
    console.log("stackList:" + JSON.stringify(stackList));
    return stackList.some((s: any) => s.name === stackName);
}
export function pulumiProperty(config: Config, key: string): string {
    const pulumiKey = snakeToCamel(key);
    const response = config.get(pulumiKey);
    if (response === undefined) {
        errorLog(`Key ${key}, pulumiKey ${pulumiKey} is not configured`);
    }
    return <string>response;
}

export function parseResource(spec: string): ParsedResource {
    const [prefix, name] = spec.split(":").map(s => s.trim());
    return { prefix: prefix, name: name };
}


export const createResourceInfo =
    (resourceType: string, resource: any, binding: string, existing: boolean = false) =>
        ({ type: resourceType, resource, binding, existing });

export function extractBinding(input: string): string {
    if (!input) return '';

    const mainPart = input.split(':')[0];
    const underscoreIndex = mainPart.indexOf('_');

    return underscoreIndex > -1 && underscoreIndex < mainPart.length - 1
        ? mainPart.slice(underscoreIndex + 1).toUpperCase()
        : '';
}

export function getD1DbName(cloudflareResource: string, projectId: string): string | undefined {
    const d1SpecList = cloudflareResource
        .split(',')
        .map(s => s.trim())
        .filter(s => s.startsWith('d1_'));

    if (d1SpecList.length == 0) return undefined;
    const d1Spec = d1SpecList[0];

    if (d1Spec.includes(':')) {
        return d1Spec.split(':')[1]?.trim() || undefined;
    }
    return `${d1Spec}_${projectId}`;
}
export function splitDomain(customDomain: string) {
    const parts = customDomain.split(".");
    if (parts.length < 2) {
        throw new Error("Invalid domain: " + customDomain);
    }
    // Zone = last 2 parts
    const zoneName = parts.slice(-2).join(".");
    // Subdomain = everything before zone
    const subdomain = parts.slice(0, -2).join(".");
    return { subdomain, zoneName };
}