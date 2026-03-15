import * as fs from 'fs';
import * as path from 'path';

const targetFile = process.argv[2]?.replace(/^["']|["']$/g, '');
if (!targetFile) {
    console.error('Usage: tsx create-wrangler-toml.ts <target-path>');
    process.exit(1);
}

const content = fs.readFileSync(0, 'utf-8');
fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, content);
console.log(`Created: ${targetFile}`);