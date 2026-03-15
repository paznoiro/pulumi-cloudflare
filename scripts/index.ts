import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import * as command from '@pulumi/command';
import * as path from 'path';
import {
    CloudflareResources,
    createResourceInfo,
    extractBinding,
    getD1DbName,
    ParsedResource,
    parseResource,
    PROJECT_DIR,
    PROP,
    PULUMI_DIR,
    pulumiProperty, splitDomain,
    snakeToCamel,
} from "./common/index.js";
import {createD1Toml, createKVToml, createRoutesToml, createToml, createVarsToml} from "./common/templateutils.js";
import {createWorkerBindings} from "./common/secret-binding.js";

const config = new pulumi.Config();
const stackName = pulumi.getStack();

const projectRoot = PROJECT_DIR;
const instanceDir = path.join(PULUMI_DIR, "instances", stackName);
const wranglerTomlFile = path.join(instanceDir, 'wrangler.toml');

console.log(`🗂 Pulumi Config instanceDir: ${instanceDir}`)

const projectId = pulumiProperty(config, PROP.PROJECT_ID);
const projectType = pulumiProperty(config, PROP.PROJECT_TYPE);
const cloudFlareResource = pulumiProperty(config, PROP.CLOUDFLARE_RESOURCE)!;
const environment = pulumiProperty(config, PROP.ENVIRONMENT);
const customDomain = config.get(snakeToCamel("CUSTOM_DOMAIN"));
const cronTrigger = config.get(snakeToCamel("CRON_TRIGGER"));

const apiToken = config.requireSecret(snakeToCamel(PROP.CLOUDFLARE_API_TOKEN));
const accountId = config.require(snakeToCamel(PROP.CLOUDFLARE_ACCOUNT_ID));

const resources = cloudFlareResource.split(',').map(r => r.trim());


async function createCloudFlareResources(accountId: string, resources: string[], projectId: string): Promise<CloudflareResources> {
    let response: CloudflareResources = {
        kv: [], d1: [], r2: [], ai: false
    };
    for (const resourceType of resources) {
        let inputResource: ParsedResource = parseResource(resourceType);
        const resourceName = inputResource.name ?? `${resourceType}_${projectId}`;

        console.log(`📦 Configuring Resources ${resourceName}`)
        const binding = extractBinding(resourceType);
        // const existing = await getExistingResource(accountId, resourceType, resourceName);
        if (resourceType.startsWith('kv_')) {
            // if (loadExistingResource(resourceType, resourceName, binding, existing, response.kv)) continue;
            const kvResource = new cloudflare.WorkersKvNamespace(resourceName, {
                accountId: accountId,
                title: resourceName,
            });
            response.kv!.push(createResourceInfo(resourceType, kvResource, binding));
        } else if (resourceType.startsWith('d1_')) {
            // if (loadExistingResource(resourceType, resourceName, binding, existing, response.d1)) continue;
            const d1Resource = new cloudflare.D1Database(resourceName, {
                accountId: accountId,
                name: resourceName,
                readReplication: {mode: 'disabled'}
            });
            response.d1!.push(createResourceInfo(resourceType, d1Resource, binding));
        } else if (resourceType.startsWith('r2_')) {
            // if (loadExistingResource(resourceType, resourceName, binding, existing, response.r2)) continue;
            const r2Resource = new cloudflare.R2Bucket(resourceName, {
                accountId: accountId,
                name: resourceName
            });
            response.r2!.push(createResourceInfo(resourceType, r2Resource, binding));
        } else if (resourceType === 'ai') {
            response.ai = true;
        }
    }
    return response;
}

function createFinalToml(cloudflareResouces: CloudflareResources, projectId: string, accountId: string) {
    const d1Value = createD1Toml(cloudflareResouces.d1);
    const kvValue = createKVToml(cloudflareResouces.kv);
    const r2Value = '';
    const aiValue = cloudflareResouces.ai ? '[ai]\nbinding = "AI"' : '';
    let routeValue = pulumi.output("");
    const pattern = config.get(snakeToCamel("CUSTOM_DOMAIN"));
    if (pattern) {
        routeValue = createRoutesToml(pattern);
        console.log("Custom Domain:" + pattern);
    } else {
        console.log("No Custom Domain Defined");
    }

    let allConfig = pulumi.runtime.allConfig()
    const varsValue = createVarsToml(allConfig);

    return pulumi.all([d1Value, kvValue, routeValue]).apply(([resolvedD1, resolvedKv, resolvedRoute]) => {
        return createToml(projectId, accountId, resolvedD1, resolvedKv, r2Value, varsValue, aiValue, resolvedRoute);
    });
}

const cloudflareResources = await createCloudFlareResources(accountId, resources, projectId);
const resourceObjects = [
    ...((cloudflareResources?.kv ?? [])),
    ...((cloudflareResources?.d1 ?? [])),
    ...((cloudflareResources?.r2 ?? []))]
    .filter(x => !x.existing)
    .map(x => x.resource);

console.log(`📦 Cloudflare Resource To be Created : ${resourceObjects.length} 📦`)
const finalToml = createFinalToml(cloudflareResources, projectId, accountId);

const createWranglerToml = new command.local.Command(
    "write-wrangler-toml",
    {
        create: pulumi.interpolate`npx tsx ${path.join(".", "pulumi-cloudflare", "scripts", "create-wrangler-toml.ts")} "${wranglerTomlFile}"`,
        stdin: finalToml,
        dir: projectRoot,
    },
    {dependsOn: resourceObjects}
);

let d1DbName = getD1DbName(cloudFlareResource, projectId);

const applySchema = d1DbName ? new command.local.Command(
    'apply-d1-schema',
    {
        create: `wrangler d1 migrations apply ${d1DbName} --remote --config ${wranglerTomlFile}`,
        dir: projectRoot,
        environment: {
            CLOUDFLARE_API_TOKEN: apiToken,
            CLOUDFLARE_ACCOUNT_ID: accountId,
            WRANGLER_SEND_METRICS: 'false',
        },
        triggers: [new Date().toISOString()],
    },
    {dependsOn: [createWranglerToml]}
) : undefined;

let deployment = [];
if (projectType == 'worker') {

    const bindings = createWorkerBindings(config);
    console.log("Binding:" + bindings)
    const worker = new cloudflare.WorkersScript(projectId, {
        accountId: accountId,
        content: `
                    addEventListener("fetch", event => {
                        event.respondWith(new Response("Hello world Script"))
                    });
                `,
        scriptName: projectId,
        bindings: bindings

    });

    const deployWorker = new command.local.Command(
        'deploy-worker',
        {
            create: `wrangler deploy --config ${wranglerTomlFile}`,
            dir: projectRoot,
            environment: {
                CLOUDFLARE_API_TOKEN: apiToken,
                CLOUDFLARE_ACCOUNT_ID: accountId,
                WRANGLER_SEND_METRICS: 'false',
            },
            triggers: [new Date().toISOString()],
        },
        {dependsOn: [worker, createWranglerToml]}
    );
    if (cronTrigger) {
            console.log(`⏰ Creating cron trigger with schedules: ${cronTrigger}`);
            const cronTriggerResource = new cloudflare.WorkersCronTrigger(`${projectId}_cron`, {
                accountId: accountId,
                scriptName: projectId,
                schedules: cronTrigger
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean)
                    .map(cron => ({ cron })),
            }, { dependsOn: [deployWorker] });
        }

        deployment.push(deployWorker);
}
if (projectType == 'pages') {
    const pagesProject = new cloudflare.PagesProject(projectId, {
        accountId: accountId,
        name: projectId,
        productionBranch: environment,
        buildConfig: {
            buildCommand: "npm run build",
            destinationDir: "dist",
        }
    });

    if (customDomain) {
        const pagesDomain = new cloudflare.PagesDomain(projectId + "_pagesdomain", {
            accountId: accountId,
            name: customDomain,
            projectName: projectId,
        }, {dependsOn: [pagesProject]});

        let domain = splitDomain(customDomain);
        const zone = cloudflare.getZones({
            account: {
                id: accountId
            },
            name: domain.zoneName
        });
        const zoneId = zone.then(z => {
            if (!z.results || z.results.length === 0) {
                throw new Error(`No Cloudflare zone found for ${domain.zoneName}`);
            }
            return z.results[0].id;
        });
        const cnameRecord = new cloudflare.DnsRecord(projectId + "_cnameRecord", {
            zoneId: zoneId,
            name: domain.subdomain,
            type: "CNAME",
            ttl: 1,
            proxied: true,
            content: `${projectId}.pages.dev`
        }, {dependsOn: [pagesDomain]});

    }
    const plainTextEnvProps = pulumi
        .all(createWorkerBindings(config))
        .apply(bindings =>
            Object.fromEntries(
                bindings
                    .filter(b => b.type === "plain_text")
                    .map(b => [`VITE_${b.name}`, b.text ?? ""]) // ensure no undefined
            )
        );

    const buildDeployPages = new command.local.Command(
        'build-deploy-pages',
        {
            create: pulumi.interpolate`npx tsx ${path.join(".", "pulumi-cloudflare", "scripts", "wrangler-pages-deploy.ts")} "${projectId}" "${environment}" ${customDomain}`,
            dir: projectRoot,
            environment: plainTextEnvProps,
            triggers: [new Date().toISOString()],

        }, {dependsOn: [...resourceObjects, pagesProject]}
    )

}