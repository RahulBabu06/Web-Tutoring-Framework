// Syntax-checks every JavaScript file in the project (node --check), skipping dependencies.
import { execFileSync } from "child_process";
import fs from "fs";
import { join } from "path";

const skip = new Set(["node_modules", ".git", "data"]);

function listJsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (skip.has(entry.name)) {
            return [];
        }

        const path = join(dir, entry.name);
        return entry.isDirectory() ? listJsFiles(path) : entry.name.endsWith(".js") ? [path] : [];
    });
}

let failed = 0;

for (const file of listJsFiles(".")) {
    try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (error) {
        failed += 1;
        console.error(`${file}\n${error.stderr}`);
    }
}

console.log(failed === 0 ? "All files passed node --check." : `${failed} file(s) failed node --check.`);
process.exit(failed === 0 ? 0 : 1);
