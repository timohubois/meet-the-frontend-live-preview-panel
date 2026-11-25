import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Keep the Chromium tests selectable even when they share a file with unit tests.
export function testInChromium(name, ...args) {
    return test(`Chromium: ${name}`, ...args);
}

// Share local pages and isolated profiles, not the suites' different input drivers.
export async function withChromiumPage(html, run) {
    const directory = await mkdtemp(join(tmpdir(), 'mtflpp-chromium-'));
    try {
        const page = join(directory, 'test.html');
        await writeFile(page, html);
        return await run({
            url: pathToFileURL(page).href,
            args: ['--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking',
                `--user-data-dir=${join(directory, 'profile')}`],
        });
    } finally {
        // Subprocesses can still be releasing profile files after the main process exits.
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
}

export async function runChromiumTests(t, { script, count, head = '', virtualTimeBudget = 10000 }) {
    const html = `<!doctype html><html><head>${head}</head><body>
        <script id="results" type="application/json">null</script><script type="module">
            document.getElementById('results').textContent = JSON.stringify(await (${script.replace(/<\/script/gi, '<\\/script')}));
        </script></body></html>`;
    return withChromiumPage(html, async ({ args, url }) => {
        const result = spawnSync(process.env.CHROMIUM_BIN || 'chromium', [
            ...args, `--virtual-time-budget=${virtualTimeBudget}`, '--dump-dom', url,
        ], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const output = result.stdout.match(/<script id="results" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
        assert.ok(output && output !== 'null', `Browser tests did not finish.\n${result.stderr}\n${result.stdout}`);
        const results = JSON.parse(output);
        assert.equal(results.length, count, 'All browser checks must report a result.');
        for (const result of results) await t.test(result.name, () => assert.equal(result.error, undefined, result.error));
    });
}
