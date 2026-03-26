import {Reader} from "properties-reader";
import {
    argsOf,
    CLIOptions,
    errorLog,
    executeRaw,
    extractStackName,
    getProcessEnv,
    isSecret,
    prompt,
    PROP,
    PULUMI_DIR,
    propertyReader,
    pulumiConfig,
    pulumiUp,
    validatePassPhrase,
    snakeToCamel, ensurePulumiLogin, ExecuteOptions, isStackValid, resolveValue
} from "./common/index.js";
import * as fs from "fs";

async function setup(options: CLIOptions): Promise<void> {
    console.log('=================================');
    console.log('🎬 Infrastructure Setup');
    console.log('=================================\n');
    let setupProperties = await validateProperties(options.propertiesFile!, options.auto);
    await ensurePulumiLogin();
    console.log(`🗓 Loading properties from: ${setupProperties}`);
    const reader = propertyReader(setupProperties);
    await validateKeys(reader, Object.values(PROP));
    const execOptions: ExecuteOptions = {
        cwd: PULUMI_DIR,
        env: {...process.env},
        shell: false,
        stdoutPipe: false
    };
    execOptions.env = getProcessEnv(reader);
    const passphrase = await validatePassPhrase(options.auto, execOptions.env);
    if (passphrase) {
        execOptions.env.PULUMI_CONFIG_PASSPHRASE = passphrase;
    }
    let stackName = extractStackName(reader.getRaw(PROP.BASE_URL)!);
    console.log(`🗓 Using Stack :${stackName}`)
    const stackExists = await isStackValid(stackName, execOptions);
    console.log(`\n🗓 ${stackName} exists ${stackExists}`)

    const cmdSetup = stackExists ? 'select' : 'init';
    await executeRaw('pulumi', ['stack', cmdSetup, stackName, '--cwd', PULUMI_DIR], execOptions);
    await setupPulumiConfig(reader, execOptions);
    console.log(`\n✅ Completed Pulumi Config Creation\n`);
    await pulumiUp(execOptions);
}


async function setupPulumiConfig(reader: Reader, execOptions: ExecuteOptions) {
    const keys = Object.keys(reader.getAllProperties());

    for (const key of keys) {
        const rawValue = reader.getRaw(key)!;
        const resolvedValue = resolveValue(rawValue)
        await pulumiConfig(snakeToCamel(key), resolvedValue, isSecret(key), execOptions);
    }
}


async function validateProperties(propertiesFile: string, auto: boolean): Promise<string> {
    if (fs.existsSync(propertiesFile)) {
        return propertiesFile;
    }
    if (auto) {
        errorLog(`Properties file not found: ${propertiesFile}`);
    }
    let validPath = propertiesFile;
    while (!fs.existsSync(validPath)) {
        validPath = await prompt({
            message: 'Properties file not found. Enter path:',
            placeholder: './setup.properties',
            defaultValue: './setup.properties'
        });
    }
    return validPath;
}

async function validateKeys(reader: Reader, keys: string[]): Promise<void> {
    for (let key of keys) {
        let value = reader.getRaw(key);
        if (value == null) {
            errorLog(`Missing Key ${key}`);
        }
    }
}

const options = argsOf();
setup(options).catch((error: Error) => {
    console.error('❌ Setup failed:', error.message);
    console.error("🛑 Stack:", error.stack);
    process.exit(1);
});
