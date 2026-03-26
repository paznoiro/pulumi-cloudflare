/**
 * Authentication and Configuration Utilities
 */


import {CloudflareCredentials, PROP} from './types.js';
import {executeRaw, resolveValue} from './utils.js';
import {Reader} from "properties-reader";

export function getCloudflareEnv(creds: CloudflareCredentials): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {...process.env};
    if (!creds.apiToken || !creds.accountId) {
        throw new Error('Cloudflare API Credentials is not available');
    }

    env.CLOUDFLARE_API_TOKEN = creds.apiToken;
    env.CLOUDFLARE_ACCOUNT_ID = creds.accountId;
    env.WRANGLER_SEND_METRICS = 'false';

    delete env.CLOUDFLARE_EMAIL;
    delete env.CLOUDFLARE_API_KEY;
    delete env.CF_API_TOKEN;
    delete env.CF_ACCOUNT_ID;
    delete env.CF_API_KEY;
    delete env.WRANGLER_API_TOKEN;
    delete env.WRANGLER_ACCOUNT_ID;

    return env;
}


export function getProcessEnv(reader: Reader): NodeJS.ProcessEnv {
    let creds: CloudflareCredentials = {
        apiToken: resolveValue(reader.getRaw(PROP.CLOUDFLARE_API_TOKEN)!.trim()),
        accountId: resolveValue(reader.getRaw(PROP.CLOUDFLARE_ACCOUNT_ID)!.trim())
    }
    const env = getCloudflareEnv(creds);

    const passphrase = reader.getRaw('PULUMI_CONFIG_PASSPHRASE')?.trim();
    if (passphrase) {
        env.PULUMI_CONFIG_PASSPHRASE = passphrase;
    }

    return env;
}

export async function isPulumiLoggedIn(): Promise<boolean> {
    try {
        await executeRaw('pulumi', ['whoami']);
        return true;
    } catch {
        return false;
    }
}


export async function ensurePulumiLogin(): Promise<void> {
    if (!(await isPulumiLoggedIn())) {
        console.error('❌ Not logged in to Pulumi. Run: pulumi login');
        process.exit(1);
    }
}
